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
    useSettingsStore,
    useTimestampStoreBase,
} from '/@/renderer/store';
import { logger } from '/@/renderer/utils/logger';
import { toast } from '/@/shared/components/toast/toast';
import { QueueSong, QueueSongAddedBy } from '/@/shared/types/domain-types';
import {
    ItemListKey,
    PlayerRepeat,
    PlayerShuffle,
    PlayerStatus,
    ServerType,
    TableColumn,
} from '/@/shared/types/types';

// Peer-to-peer "listen together" over WebRTC data channels.
// Star topology: the host is the source of truth and relays. Guests send their local
// changes to the host, the host applies them and rebroadcasts its state to everyone.
// Signaling uses the free public PeerJS server, so nothing needs to be self-hosted.

const PEER_PREFIX = 'feishin-lt-';
const HEARTBEAT_MS = 4000;
const DRIFT_TOLERANCE_S = 2.5;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export type ListenTogetherMember = { name: string; userId: null | string };

interface ListenTogetherState {
    code: null | string;
    hostAutoDJ: boolean;
    members: ListenTogetherMember[];
    role: 'guest' | 'host' | null;
    status: 'connected' | 'connecting' | 'idle';
}

type Message =
    | { autoDJ: boolean; members: ListenTogetherMember[]; t: 'members' }
    | {
          items: QueueSong[];
          repeat: PlayerRepeat;
          shuffle: PlayerShuffle;
          shuffled: number[];
          t: 'queue';
      }
    | {
          member: ListenTogetherMember;
          serverKey: string;
          serverType: string;
          t: 'hello';
      }
    | { pos: number; status: PlayerStatus; t: 'state'; uid: null | string }
    | { t: 'reject' };
type QueueMessage = Extract<Message, { t: 'queue' }>;

type StateMessage = Extract<Message, { t: 'state' }>;

export const useListenTogetherStore = createWithEqualityFn<ListenTogetherState>()(() => ({
    code: null,
    hostAutoDJ: false,
    members: [],
    role: null,
    status: 'idle',
}));

let peer: null | Peer = null;
let hostConn: DataConnection | null = null;
const guests = new Map<DataConnection, ListenTogetherMember>();
let unsubscribers: (() => void)[] = [];
let heartbeat: ReturnType<typeof setInterval> | undefined;
let applying = 0;
let lastQueueSig = '';
let queueSendTimer: ReturnType<typeof setTimeout> | undefined;
let stateDirty = false;
// Peers confirmed to use the same library (same server URL, or songs spot-checked).
let trusted = new WeakSet<DataConnection>();
// Incoming messages are handled one at a time, since library checks are async.
let inbox = Promise.resolve();
// Skip heartbeats while a delayed seek is pending, so they don't broadcast a stale position.
let seekPendingUntil = 0;
// >0 while auto DJ is adding songs, so they get attributed to it.
let autoDJDepth = 0;

const QUEUE_LIST_KEYS = [ItemListKey.QUEUE_SONG, ItemListKey.SIDE_QUEUE, ItemListKey.FULL_SCREEN];

const setStore = (partial: Partial<ListenTogetherState>) =>
    useListenTogetherStore.setState(partial);

export const myMember = (): ListenTogetherMember => {
    const server = useAuthStore.getState().currentServer;
    return { name: server?.username || 'Guest', userId: server?.userId ?? null };
};

export const runAsAutoDJ = async (fn: () => Promise<unknown> | unknown) => {
    autoDJDepth++;
    try {
        await fn();
        // Tag now, while still flagged; deferred tagging would run after the flag cleared.
        tagNewSongs();
    } finally {
        autoDJDepth--;
    }
};

// Attribute untagged queue entries to us (or to auto DJ). Songs from peers arrive
// already tagged by whoever added them.
const tagNewSongs = () => {
    const { queue } = usePlayerStoreBase.getState();
    const untagged = queue.default.filter((uid) => queue.songs[uid] && !queue.songs[uid]._addedBy);
    if (!untagged.length) return;

    const addedBy: QueueSongAddedBy = { ...myMember(), ...(autoDJDepth ? { autoDJ: true } : {}) };
    applyRemote(() => {
        usePlayerStoreBase.setState((state) => {
            untagged.forEach((uid) => {
                const song = state.queue.songs[uid];
                if (song) song._addedBy = addedBy;
            });
        });
    });
};

// Tagging also runs outside sessions, so the column is useful solo (me vs. auto DJ).
// Deferred: updating the store inside its own listener swallows other notifications.
let tagTimer: ReturnType<typeof setTimeout> | undefined;
subscribePlayerQueue(() => {
    clearTimeout(tagTimer);
    tagTimer = setTimeout(tagNewSongs, 0);
});

// Turn the "Added by" column on in the queue views the first time a session starts.
// Once the column exists in a view's config, the user's choice is left alone.
const ensureAddedByColumn = () => {
    let added = false;
    useSettingsStore.setState((state) => {
        QUEUE_LIST_KEYS.forEach((key) => {
            const columns = state.lists[key]?.table.columns;
            if (!columns || columns.some((c) => c.id === TableColumn.ADDED_BY)) return;
            columns.push({
                align: 'center',
                autoSize: false,
                id: TableColumn.ADDED_BY,
                isEnabled: true,
                pinned: null,
                width: 60,
            });
            added = true;
        });
    });
    if (added) toast.info({ message: i18n.t('listenTogether.addedByColumnEnabled') });
};

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

const send = (msg: Message) => {
    if (hostConn) {
        if (hostConn.open) hostConn.send(msg);
        return;
    }
    guests.forEach((_, conn) => {
        if (conn.open) conn.send(msg);
    });
};

const sendQueue = () => {
    const msg = buildQueueMessage();
    const sig = queueSig(msg);
    if (sig === lastQueueSig) return;
    lastQueueSig = sig;
    send(msg);
};

// Tags new songs, then sends the queue (before any state that may reference new songs).
const flush = () => {
    clearTimeout(queueSendTimer);
    tagNewSongs();
    sendQueue();
    if (stateDirty) {
        stateDirty = false;
        send(buildStateMessage());
    }
};

// Both run inside player store listeners, so they only schedule work. Updating the
// store from inside a listener (tagging) makes zustand swallow the remaining
// notifications of the outer update, which lost track/status changes.
const scheduleQueueSend = () => {
    if (applying) return;
    clearTimeout(queueSendTimer);
    // Coalesce bursts of queue mutations into one message.
    queueSendTimer = setTimeout(flush, 150);
};

const sendState = () => {
    if (applying) return;
    stateDirty = true;
    clearTimeout(queueSendTimer);
    queueSendTimer = setTimeout(flush, 0);
};

const hashServerUrl = async (url: string) => {
    const bytes = new TextEncoder().encode(url.trim().toLowerCase().replace(/\/+$/, ''));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
};

// Identifies the server independent of the URL used to reach it. Jellyfin exposes a
// stable server id; Subsonic/Navidrome have none, so fall back to a hash of the URL.
export const getServerKey = async () => {
    const server = useAuthStore.getState().currentServer;
    if (!server) return '';
    if (server.type === ServerType.JELLYFIN) {
        try {
            const res = await fetch(`${server.url.replace(/\/+$/, '')}/System/Info/Public`);
            const info = (await res.json()) as { Id?: string };
            if (info.Id) return `jellyfin:${info.Id}`;
        } catch (error) {
            logger.warn('Listen together: could not read Jellyfin server id', { error });
        }
    }
    return `url:${await hashServerUrl(server.url)}`;
};

const buildHello = async (): Promise<Message> => ({
    member: myMember(),
    serverKey: await getServerKey(),
    serverType: useAuthStore.getState().currentServer?.type ?? '',
    t: 'hello',
});

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

// Favorite, rating and play stats belong to each user's own account, so they never come
// from a peer. Unknown songs start blank and are filled in from our own server.
type UserData = Pick<QueueSong, 'lastPlayedAt' | 'playCount' | 'userFavorite' | 'userRating'>;
const NO_USER_DATA: UserData = {
    lastPlayedAt: null,
    playCount: 0,
    userFavorite: false,
    userRating: null,
};
const pickUserData = (song: UserData): UserData => ({
    lastPlayedAt: song.lastPlayedAt,
    playCount: song.playCount,
    userFavorite: song.userFavorite,
    userRating: song.userRating,
});

const loadUserData = async (ids: string[]) => {
    const server = useAuthStore.getState().currentServer;
    if (!server) return;
    for (let i = 0; i < ids.length; i += 5) {
        const songs = await Promise.all(
            ids
                .slice(i, i + 5)
                .map((id) =>
                    api.controller
                        .getSongDetail({ apiClientProps: { serverId: server.id }, query: { id } })
                        .catch(() => null),
                ),
        );
        const byId = new Map(songs.filter((song) => song).map((song) => [song!.id, song!]));
        if (!byId.size) continue;
        applyRemote(() => {
            usePlayerStoreBase.setState((state) => {
                Object.values(state.queue.songs).forEach((song) => {
                    const own = byId.get(song.id);
                    if (own) Object.assign(song, pickUserData(own));
                });
            });
        });
    }
};

const applyQueue = (msg: QueueMessage) => {
    lastQueueSig = queueSig(msg);
    const server = useAuthStore.getState().currentServer;
    if (!server) return;

    const currentUid = getCurrentUid();
    const ownData = new Map(
        Object.values(usePlayerStoreBase.getState().queue.songs).map((song) => [
            song.id,
            pickUserData(song),
        ]),
    );
    const unknownIds = [...new Set(msg.items.map((item) => item.id))].filter(
        (id) => !ownData.has(id),
    );

    applyRemote(() => {
        usePlayerStoreBase.setState((state) => {
            // Song ids are shared when everyone uses the same library; the server id is
            // local to each install, so point every song at our own current server.
            state.queue.songs = Object.fromEntries(
                msg.items.map((item) => [
                    item._uniqueId,
                    {
                        ...item,
                        ...(ownData.get(item.id) ?? NO_USER_DATA),
                        _serverId: server.id,
                    },
                ]),
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

    if (unknownIds.length) {
        loadUserData(unknownIds).catch((error) =>
            logger.warn('Listen together: could not load own song data', { error }),
        );
    }
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
    const members = [myMember(), ...guests.values()];
    const autoDJ = useSettingsStore.getState().autoDJ.enabled;
    setStore({ hostAutoDJ: autoDJ, members });
    send({ autoDJ, members, t: 'members' });
};

const handleMessage = async (msg: Message, from: DataConnection) => {
    switch (msg.t) {
        case 'hello': {
            const server = useAuthStore.getState().currentServer;
            const ownKey = await getServerKey();
            const bothJellyfin =
                ownKey.startsWith('jellyfin:') && msg.serverKey.startsWith('jellyfin:');
            if (
                !server ||
                msg.serverType !== server.type ||
                (bothJellyfin && ownKey !== msg.serverKey)
            ) {
                rejectPeer(from);
                return;
            }
            // Same URL is enough for Subsonic/Navidrome. On Jellyfin the server id only
            // proves it is the same server, so the song check still runs to confirm the
            // peer's account can access the same libraries.
            if (!bothJellyfin && ownKey === msg.serverKey) trusted.add(from);
            if (!hostConn) {
                guests.set(from, msg.member);
                broadcastMembers();
            }
            break;
        }
        case 'members':
            setStore({ hostAutoDJ: msg.autoDJ, members: msg.members });
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
            // Host relays to everyone, the sender included: if the host or another guest
            // edited the queue at the same time, the edits crossed in flight, and echoing
            // the host's final version makes all peers converge on it.
            if (!hostConn) send(msg);
            break;
        case 'reject':
            rejectPeer(from);
            break;
        case 'state':
            // No trust check: states only point at songs already in our queue, and
            // applyState ignores unknown ones. Gating here silently dropped play/pause
            // from guests on a different server URL until they added a new song.
            applyState(msg);
            if (!hostConn) send(msg);
            break;
    }
};

const receive = (msg: Message, from: DataConnection) => {
    inbox = inbox
        .then(() => handleMessage(msg, from))
        .catch((error) => logger.error('Listen together: message failed', { error }));
};

const startSync = () => {
    ensureAddedByColumn();
    unsubscribers = [
        subscribePlayerQueue(scheduleQueueSend),
        subscribePlayerRepeat(scheduleQueueSend),
        subscribePlayerShuffle(scheduleQueueSend),
        subscribeCurrentTrack(sendState),
        subscribePlayerStatus(sendState),
        subscribePlayerSeekToTimestamp(sendState),
    ];
};

export const createPeer = (id?: string) =>
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
            guests.set(conn, { name: 'Guest', userId: null });
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

    startSync();
    lastQueueSig = queueSig(buildQueueMessage());
    unsubscribers.push(
        useSettingsStore.subscribe(
            (state) => state.autoDJ.enabled,
            () => broadcastMembers(),
        ),
    );
    heartbeat = setInterval(() => {
        if (guests.size && !applying && Date.now() > seekPendingUntil) send(buildStateMessage());
    }, HEARTBEAT_MS);
    setStore({
        hostAutoDJ: useSettingsStore.getState().autoDJ.enabled,
        members: [myMember()],
        status: 'connected',
    });
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
    stateDirty = false;
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
    setStore({ code: null, hostAutoDJ: false, members: [], role: null, status: 'idle' });
};
