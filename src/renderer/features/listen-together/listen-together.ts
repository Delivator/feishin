import Peer, { DataConnection } from 'peerjs';
import { createWithEqualityFn } from 'zustand/traditional';

import i18n from '/@/i18n/i18n';
import { api } from '/@/renderer/api';
import {
    subscribeCurrentTrack,
    subscribePlayerQueue,
    subscribePlayerRepeat,
    subscribePlayerSeekToTimestamp,
    subscribePlayerShuffle,
    subscribePlayerStatus,
    useAuthStore,
    usePlayerStoreBase,
    useTimestampStoreBase,
} from '/@/renderer/store';
import { logger } from '/@/renderer/utils/logger';
import { toast } from '/@/shared/components/toast/toast';
import { QueueSong } from '/@/shared/types/domain-types';
import { PlayerRepeat, PlayerShuffle, PlayerStatus } from '/@/shared/types/types';

// Peer-to-peer "listen together" over WebRTC data channels.
// Star topology: the host is the source of truth and relays. Guests send their local
// changes to the host, the host applies them and rebroadcasts its state to everyone.
// Signaling uses the free public PeerJS server, so nothing needs to be self-hosted.

const PEER_PREFIX = 'feishin-lt-';
const HEARTBEAT_MS = 4000;
const DRIFT_TOLERANCE_S = 2.5;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

interface ListenTogetherState {
    code: null | string;
    members: string[];
    role: 'guest' | 'host' | null;
    status: 'connected' | 'connecting' | 'idle';
}

type Message =
    | {
          items: QueueSong[];
          repeat: PlayerRepeat;
          shuffle: PlayerShuffle;
          shuffled: number[];
          t: 'queue';
      }
    | { name: string; serverType: string; t: 'hello'; urlHash: string }
    | { names: string[]; t: 'members' }
    | { pos: number; status: PlayerStatus; t: 'state'; uid: null | string }
    | { t: 'reject' };
type QueueMessage = Extract<Message, { t: 'queue' }>;

type StateMessage = Extract<Message, { t: 'state' }>;

export const useListenTogetherStore = createWithEqualityFn<ListenTogetherState>()(() => ({
    code: null,
    members: [],
    role: null,
    status: 'idle',
}));

let peer: null | Peer = null;
let hostConn: DataConnection | null = null;
const guests = new Map<DataConnection, string>();
let unsubscribers: (() => void)[] = [];
let heartbeat: ReturnType<typeof setInterval> | undefined;
let applying = 0;
let lastQueueSig = '';
let queueSendTimer: ReturnType<typeof setTimeout> | undefined;
// Peers confirmed to use the same library (same server URL, or songs spot-checked).
let trusted = new WeakSet<DataConnection>();
// Incoming messages are handled one at a time, since library checks are async.
let inbox = Promise.resolve();
// Skip heartbeats while a delayed seek is pending, so they don't broadcast a stale position.
let seekPendingUntil = 0;

const setStore = (partial: Partial<ListenTogetherState>) =>
    useListenTogetherStore.setState(partial);

const myName = () => useAuthStore.getState().currentServer?.username || 'Guest';

const randomCode = () =>
    Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => CODE_ALPHABET[b % 32]).join('');

// Run a local store change without echoing it back to the session.
const applyRemote = (fn: () => void) => {
    applying++;
    try {
        fn();
    } finally {
        applying--;
    }
};

const getCurrentUid = () => {
    const state = usePlayerStoreBase.getState();
    return state.getCurrentSong()?._uniqueId ?? null;
};

const buildQueueMessage = (): QueueMessage => {
    const { player, queue } = usePlayerStoreBase.getState();
    return {
        items: queue.default.map((uid) => queue.songs[uid]).filter(Boolean),
        repeat: player.repeat,
        shuffle: player.shuffle,
        shuffled: queue.shuffled,
        t: 'queue',
    };
};

const queueSig = (m: QueueMessage) =>
    `${m.items.map((i) => i._uniqueId).join(',')}|${m.shuffled.join(',')}|${m.shuffle}|${m.repeat}`;

const buildStateMessage = (): StateMessage => ({
    pos: useTimestampStoreBase.getState().timestamp,
    status: usePlayerStoreBase.getState().player.status,
    t: 'state',
    uid: getCurrentUid(),
});

const send = (msg: Message, except?: DataConnection) => {
    if (hostConn) {
        if (hostConn.open) hostConn.send(msg);
        return;
    }
    guests.forEach((_, conn) => {
        if (conn !== except && conn.open) conn.send(msg);
    });
};

const sendQueue = () => {
    const msg = buildQueueMessage();
    const sig = queueSig(msg);
    if (sig === lastQueueSig) return;
    lastQueueSig = sig;
    send(msg);
};

// Coalesce bursts of queue mutations into one message.
const scheduleQueueSend = () => {
    if (applying) return;
    clearTimeout(queueSendTimer);
    queueSendTimer = setTimeout(sendQueue, 150);
};

const sendState = () => {
    if (applying) return;
    // Queue must arrive before a state that references a new song.
    clearTimeout(queueSendTimer);
    sendQueue();
    send(buildStateMessage());
};

const hashServerUrl = async (url: string) => {
    const bytes = new TextEncoder().encode(url.trim().toLowerCase().replace(/\/+$/, ''));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
};

const buildHello = async (): Promise<Message> => {
    const server = useAuthStore.getState().currentServer;
    return {
        name: myName(),
        serverType: server?.type ?? '',
        t: 'hello',
        urlHash: server ? await hashServerUrl(server.url) : '',
    };
};

// The same server can be reached through different URLs (LAN vs. public), so when the
// URLs differ, check that a few of the peer's songs exist on our own server.
// Returns null when there is nothing new to check.
const songsExistLocally = async (items: QueueSong[]) => {
    const server = useAuthStore.getState().currentServer;
    if (!server) return false;
    const known = usePlayerStoreBase.getState().queue.songs;
    const sample = items.filter((item) => !known[item._uniqueId]).slice(0, 3);
    if (!sample.length) return null;
    try {
        const found = await Promise.all(
            sample.map((item) =>
                api.controller.getSongDetail({
                    apiClientProps: { serverId: server.id },
                    query: { id: item.id },
                }),
            ),
        );
        return found.every((song, i) => song?.id === sample[i].id);
    } catch (error) {
        logger.warn('Listen together: song lookup failed', { error });
        return false;
    }
};

const rejectPeer = (conn: DataConnection) => {
    logger.warn('Listen together: peer uses a different library');
    if (conn === hostConn) {
        toast.error({ message: i18n.t('listenTogether.libraryMismatch') });
        leaveSession();
        return;
    }
    if (conn.open) conn.send({ t: 'reject' });
    setTimeout(() => conn.close(), 500);
};

const applyQueue = (msg: QueueMessage) => {
    lastQueueSig = queueSig(msg);
    const server = useAuthStore.getState().currentServer;
    if (!server) return;

    const currentUid = getCurrentUid();

    applyRemote(() => {
        usePlayerStoreBase.setState((state) => {
            // Song ids are shared when everyone uses the same library; the server id is
            // local to each install, so point every song at our own current server.
            state.queue.songs = Object.fromEntries(
                msg.items.map((item) => [item._uniqueId, { ...item, _serverId: server.id }]),
            );
            state.queue.default = msg.items.map((item) => item._uniqueId);
            state.queue.shuffled = msg.shuffled;
            state.player.shuffle = msg.shuffle;
            state.player.repeat = msg.repeat;

            const queueIndex = msg.items.findIndex((item) => item._uniqueId === currentUid);
            if (queueIndex !== -1) {
                const shuffledIndex =
                    msg.shuffle === PlayerShuffle.TRACK && msg.shuffled.length > 0
                        ? msg.shuffled.indexOf(queueIndex)
                        : -1;
                state.player.index = shuffledIndex !== -1 ? shuffledIndex : queueIndex;
            }
        });
    });
};

const applyState = (msg: StateMessage) => {
    const player = usePlayerStoreBase.getState();
    const localPos = useTimestampStoreBase.getState().timestamp;

    applyRemote(() => {
        if (msg.uid === null) {
            if (player.player.status === PlayerStatus.PLAYING) player.mediaPause();
            return;
        }

        if (msg.uid !== getCurrentUid()) {
            if (!usePlayerStoreBase.getState().queue.songs[msg.uid]) {
                logger.warn('Listen together: state references unknown song', { uid: msg.uid });
                return;
            }
            player.mediaPlay(msg.uid);
            if (msg.status !== PlayerStatus.PLAYING) player.mediaPause();
            if (msg.pos > 1) {
                seekPendingUntil = Date.now() + 1000;
                // Give the engine a moment to load the new source before seeking.
                setTimeout(() => applyRemote(() => player.mediaSeekToTimestamp(msg.pos)), 400);
            }
            return;
        }

        const localStatus = usePlayerStoreBase.getState().player.status;
        if (msg.status === PlayerStatus.PLAYING && localStatus !== PlayerStatus.PLAYING) {
            player.mediaPlay();
        } else if (msg.status !== PlayerStatus.PLAYING && localStatus === PlayerStatus.PLAYING) {
            player.mediaPause();
        }

        if (Math.abs(localPos - msg.pos) > DRIFT_TOLERANCE_S) {
            player.mediaSeekToTimestamp(msg.pos);
        }
    });
};

const broadcastMembers = () => {
    const names = [myName(), ...guests.values()];
    setStore({ members: names });
    send({ names, t: 'members' });
};

const handleMessage = async (msg: Message, from: DataConnection) => {
    switch (msg.t) {
        case 'hello': {
            const server = useAuthStore.getState().currentServer;
            if (!server || msg.serverType !== server.type) {
                rejectPeer(from);
                return;
            }
            if (msg.urlHash === (await hashServerUrl(server.url))) trusted.add(from);
            if (!hostConn) {
                guests.set(from, msg.name);
                broadcastMembers();
            }
            break;
        }
        case 'members':
            setStore({ members: msg.names });
            break;
        case 'queue':
            if (!trusted.has(from)) {
                const ok = await songsExistLocally(msg.items);
                if (ok === false) {
                    rejectPeer(from);
                    return;
                }
                // Songs we already have prove nothing; keep checking until a new one matched.
                if (ok) trusted.add(from);
            }
            applyQueue(msg);
            // Host relays to the other guests (the sender already has it).
            if (!hostConn) send(msg, from);
            break;
        case 'reject':
            rejectPeer(from);
            break;
        case 'state':
            if (!trusted.has(from)) return;
            applyState(msg);
            if (!hostConn) send(msg, from);
            break;
    }
};

const receive = (msg: Message, from: DataConnection) => {
    inbox = inbox
        .then(() => handleMessage(msg, from))
        .catch((error) => logger.error('Listen together: message failed', { error }));
};

const startSync = () => {
    unsubscribers = [
        subscribePlayerQueue(scheduleQueueSend),
        subscribePlayerRepeat(scheduleQueueSend),
        subscribePlayerShuffle(scheduleQueueSend),
        subscribeCurrentTrack(sendState),
        subscribePlayerStatus(sendState),
        subscribePlayerSeekToTimestamp(sendState),
    ];
};

const createPeer = (id?: string) =>
    new Promise<Peer>((resolve, reject) => {
        const p = id ? new Peer(id) : new Peer();
        p.once('open', () => resolve(p));
        p.once('error', reject);
    });

const attachPeerHandlers = (p: Peer) => {
    // Signaling server dropped us; data channels keep working, but reconnect so new
    // guests can still find the host.
    p.on('disconnected', () => {
        if (peer === p && !p.destroyed) p.reconnect();
    });
    p.on('error', (error) => logger.warn('Listen together peer error', { error }));
};

const fail = (error: unknown) => {
    logger.error('Listen together failed', { error });
    const type = (error as { type?: string })?.type;
    toast.error({
        message:
            type === 'peer-unavailable'
                ? i18n.t('listenTogether.notFound')
                : i18n.t('listenTogether.connectionFailed'),
    });
    leaveSession();
};

export const hostSession = async () => {
    if (peer) return;
    const code = randomCode();
    setStore({ code, role: 'host', status: 'connecting' });

    try {
        peer = await createPeer(PEER_PREFIX + code);
    } catch (error) {
        fail(error);
        return;
    }

    attachPeerHandlers(peer);
    peer.on('connection', (conn) => {
        conn.on('open', async () => {
            guests.set(conn, 'Guest');
            conn.send(await buildHello());
            conn.send(buildQueueMessage());
            conn.send(buildStateMessage());
        });
        conn.on('data', (data) => receive(data as Message, conn));
        conn.on('close', () => {
            guests.delete(conn);
            broadcastMembers();
        });
    });

    lastQueueSig = queueSig(buildQueueMessage());
    startSync();
    heartbeat = setInterval(() => {
        if (guests.size && !applying && Date.now() > seekPendingUntil) send(buildStateMessage());
    }, HEARTBEAT_MS);
    setStore({ members: [myName()], status: 'connected' });
    logger.info('Listen together: hosting', { code });
};

export const joinSession = async (rawCode: string) => {
    if (peer) return;
    const code = rawCode.trim().toUpperCase();
    setStore({ code, role: 'guest', status: 'connecting' });

    try {
        peer = await createPeer();
        attachPeerHandlers(peer);
        const p = peer;
        const conn = p.connect(PEER_PREFIX + code, { reliable: true });
        await new Promise<void>((resolve, reject) => {
            conn.once('open', resolve);
            conn.once('error', reject);
            p.once('error', reject);
            setTimeout(() => reject(new Error('timeout')), 15000);
        });
        hostConn = conn;
    } catch (error) {
        fail(error);
        return;
    }

    const conn = hostConn;
    conn.on('data', (data) => receive(data as Message, conn));
    hostConn.on('close', () => {
        if (!hostConn) return;
        toast.info({ message: i18n.t('listenTogether.ended') });
        leaveSession();
    });
    conn.send(await buildHello());
    startSync();
    setStore({ status: 'connected' });
    logger.info('Listen together: joined', { code });
};

export const leaveSession = () => {
    unsubscribers.forEach((unsub) => unsub());
    unsubscribers = [];
    clearInterval(heartbeat);
    clearTimeout(queueSendTimer);
    const conn = hostConn;
    hostConn = null;
    conn?.close();
    guests.clear();
    // Clear the ref first so the 'disconnected' handler does not try to reconnect.
    const p = peer;
    peer = null;
    p?.destroy();
    lastQueueSig = '';
    trusted = new WeakSet();
    setStore({ code: null, members: [], role: null, status: 'idle' });
};
