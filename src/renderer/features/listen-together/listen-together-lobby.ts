import Peer, { DataConnection } from 'peerjs';
import { createWithEqualityFn } from 'zustand/traditional';

import {
    getServerKey,
    myMember,
    useListenTogetherStore,
} from '/@/renderer/features/listen-together/listen-together';
import { usePlayerStoreBase } from '/@/renderer/store';
import { logger } from '/@/renderer/utils/logger';

// Public session discovery without a server of our own. Every client on the same music
// server derives the same lobby peer id. Whoever claims it first holds the lobby: it
// collects announcements from public hosts and sends the list to everyone connected.
// When the holder leaves, the others race to claim the id again. Nothing persists.

const LOBBY_PREFIX = 'feishin-lobby-';
const ANNOUNCE_MS = 5000;

export type PublicSession = {
    code: string;
    host: string;
    members: number;
    song: null | { artist: string; imageId: null | string; name: string };
};

type LobbyMessage =
    | { session: null | PublicSession; t: 'announce' }
    | { sessions: PublicSession[]; t: 'list' };

type Reason = 'browse' | 'publish';

export const useLobbyStore = createWithEqualityFn<{
    published: boolean;
    sessions: PublicSession[];
}>()(() => ({ published: false, sessions: [] }));

const reasons = new Set<Reason>();
let peer: null | Peer = null;
// Set when we hold the lobby: every connected client and what it announced.
let clients: Map<DataConnection, null | PublicSession> | null = null;
// Set when someone else holds the lobby.
let holderConn: DataConnection | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

const lobbyId = async () => {
    const bytes = new TextEncoder().encode(await getServerKey());
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0'));
    return LOBBY_PREFIX + hex.join('').slice(0, 32);
};

const ownSession = (): null | PublicSession => {
    const { code, members, role, status } = useListenTogetherStore.getState();
    if (!reasons.has('publish') || role !== 'host' || status !== 'connected' || !code) {
        return null;
    }
    const song = usePlayerStoreBase.getState().getCurrentSong();
    return {
        code,
        host: myMember().name,
        members: members.length,
        song: song ? { artist: song.artistName, imageId: song.imageId, name: song.name } : null,
    };
};

const broadcastList = () => {
    if (!clients) return;
    const own = ownSession();
    const sessions = [...(own ? [own] : []), ...[...clients.values()].filter((s) => s !== null)];
    useLobbyStore.setState({ sessions });
    clients.forEach((_, conn) => {
        if (conn.open) conn.send({ sessions, t: 'list' } satisfies LobbyMessage);
    });
};

const tick = () => {
    if (clients) broadcastList();
    else if (holderConn?.open) {
        holderConn.send({ session: ownSession(), t: 'announce' } satisfies LobbyMessage);
    }
};

const teardown = () => {
    clearInterval(timer);
    clearTimeout(retryTimer);
    const p = peer;
    peer = null;
    clients = null;
    holderConn = null;
    p?.destroy();
    useLobbyStore.setState({ sessions: [] });
};

const scheduleRetry = () => {
    teardown();
    if (!reasons.size) return;
    // Random delay so clients that lost the holder don't all claim at the same instant.
    retryTimer = setTimeout(connect, 500 + Math.random() * 1500);
};

const openPeer = (id?: string) =>
    new Promise<Peer>((resolve, reject) => {
        const p = id ? new Peer(id) : new Peer();
        p.once('open', () => resolve(p));
        p.once('error', (error) => {
            p.destroy();
            reject(error);
        });
    });

const hold = (p: Peer) => {
    clients = new Map();
    p.on('connection', (conn) => {
        conn.on('open', () => {
            clients?.set(conn, null);
            broadcastList();
        });
        conn.on('data', (data) => {
            const msg = data as LobbyMessage;
            if (msg.t !== 'announce' || !clients?.has(conn)) return;
            clients.set(conn, msg.session);
            broadcastList();
        });
        conn.on('close', () => {
            clients?.delete(conn);
            broadcastList();
        });
    });
    p.on('disconnected', () => {
        if (peer === p && !p.destroyed) p.reconnect();
    });
    broadcastList();
};

const join = (p: Peer, id: string) => {
    const conn = p.connect(id, { reliable: true });
    holderConn = conn;
    conn.on('open', tick);
    conn.on('data', (data) => {
        const msg = data as LobbyMessage;
        if (msg.t === 'list') useLobbyStore.setState({ sessions: msg.sessions });
    });
    conn.on('close', () => {
        if (holderConn === conn) scheduleRetry();
    });
    // The holder may have left between our claim attempt and connecting.
    p.on('error', () => {
        if (holderConn === conn) scheduleRetry();
    });
};

const connect = async () => {
    if (peer || !reasons.size) return;
    try {
        const id = await lobbyId();
        try {
            peer = await openPeer(id);
            hold(peer);
        } catch (error) {
            if ((error as { type?: string })?.type !== 'unavailable-id') throw error;
            peer = await openPeer();
            join(peer, id);
        }
        // Stopped wanting the lobby while connecting.
        if (!reasons.size) {
            teardown();
            return;
        }
        timer = setInterval(tick, ANNOUNCE_MS);
    } catch (error) {
        logger.warn('Listen together lobby failed', { error });
        scheduleRetry();
    }
};

const enter = (reason: Reason) => {
    reasons.add(reason);
    if (peer) tick();
    else connect();
};

const exit = (reason: Reason) => {
    reasons.delete(reason);
    if (!reasons.size) teardown();
    else tick();
};

export const browseLobby = () => {
    enter('browse');
    return () => exit('browse');
};

export const setPublished = (published: boolean) => {
    useLobbyStore.setState({ published });
    if (published) enter('publish');
    else exit('publish');
};

// Stop publishing when the hosted session ends; refresh the listing when it changes.
useListenTogetherStore.subscribe((state, prev) => {
    if (!reasons.has('publish')) return;
    if (state.role !== 'host' || state.status !== 'connected') setPublished(false);
    else if (state.members.length !== prev.members.length) tick();
});
