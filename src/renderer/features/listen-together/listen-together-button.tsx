import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import styles from './listen-together-button.module.css';

import { ItemImage } from '/@/renderer/components/item-image/item-image';
import {
    hostSession,
    joinSession,
    leaveSession,
    useListenTogetherStore,
} from '/@/renderer/features/listen-together/listen-together';
import {
    browseLobby,
    setPublished,
    useLobbyStore,
} from '/@/renderer/features/listen-together/listen-together-lobby';
import { useCurrentServer } from '/@/renderer/store';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Button } from '/@/shared/components/button/button';
import { CopyButton } from '/@/shared/components/copy-button/copy-button';
import { Group } from '/@/shared/components/group/group';
import { Popover } from '/@/shared/components/popover/popover';
import { Stack } from '/@/shared/components/stack/stack';
import { Switch } from '/@/shared/components/switch/switch';
import { TextInput } from '/@/shared/components/text-input/text-input';
import { Text } from '/@/shared/components/text/text';
import { LibraryItem } from '/@/shared/types/domain-types';

// Mounted only while the popover is open, so the lobby is only joined while looking.
const PublicSessions = () => {
    const { t } = useTranslation();
    const server = useCurrentServer();
    const sessions = useLobbyStore((state) => state.sessions);

    useEffect(() => browseLobby(), []);

    return (
        <Stack gap="xs">
            <Text fw={600} size="xs">
                {t('listenTogether.publicSessions')}
            </Text>
            {sessions.length === 0 && (
                <Text isMuted size="xs">
                    {t('listenTogether.noPublicSessions')}
                </Text>
            )}
            {sessions.map((session) => (
                <Group gap="sm" key={session.code} wrap="nowrap">
                    <ItemImage
                        className={styles.cover}
                        enableDebounce={false}
                        enableViewport={false}
                        id={session.song?.imageId ?? undefined}
                        itemType={LibraryItem.SONG}
                        serverId={server?.id}
                        type="table"
                    />
                    <Stack className={styles.info} gap={0}>
                        <Text size="sm" truncate>
                            {session.song?.name ?? t('listenTogether.nothingPlaying')}
                        </Text>
                        {session.song && (
                            <Text isMuted size="xs" truncate>
                                {session.song.artist}
                            </Text>
                        )}
                        <Text isMuted size="xs" truncate>
                            {session.host} ·{' '}
                            {t('listenTogether.members', { count: session.members })}
                        </Text>
                    </Stack>
                    <Button
                        onClick={() => joinSession(session.code)}
                        size="compact-sm"
                        variant="default"
                    >
                        {t('listenTogether.join')}
                    </Button>
                </Group>
            ))}
        </Stack>
    );
};

export const ListenTogetherButton = () => {
    const { t } = useTranslation();
    const { code, members, role, status } = useListenTogetherStore();
    const published = useLobbyStore((state) => state.published);
    const [joinCode, setJoinCode] = useState('');

    return (
        <Popover position="top" withArrow>
            <Popover.Target>
                <ActionIcon
                    icon="users"
                    iconProps={{
                        color: status === 'connected' ? 'primary' : undefined,
                        size: 'lg',
                    }}
                    size="sm"
                    tooltip={{ label: t('listenTogether.title'), openDelay: 0 }}
                    variant="subtle"
                />
            </Popover.Target>
            <Popover.Dropdown maw={360} miw={280} onClick={(e) => e.stopPropagation()} p="sm">
                <Stack gap="sm">
                    <Text fw={600} size="sm">
                        {t('listenTogether.title')}
                    </Text>

                    {status === 'idle' && (
                        <>
                            <Text isMuted size="xs">
                                {t('listenTogether.description')}
                            </Text>
                            <Button onClick={hostSession} variant="filled">
                                {t('listenTogether.host')}
                            </Button>
                            <Group gap="xs" wrap="nowrap">
                                <TextInput
                                    onChange={(e) => setJoinCode(e.currentTarget.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter' && joinCode.trim()) {
                                            joinSession(joinCode);
                                        }
                                    }}
                                    placeholder={t('listenTogether.code')}
                                    style={{ flex: 1 }}
                                    value={joinCode}
                                />
                                <Button
                                    disabled={!joinCode.trim()}
                                    onClick={() => joinSession(joinCode)}
                                    variant="default"
                                >
                                    {t('listenTogether.join')}
                                </Button>
                            </Group>
                            <Text isMuted size="xs">
                                {t('listenTogether.joinWarning')}
                            </Text>
                            <PublicSessions />
                        </>
                    )}

                    {status === 'connecting' && (
                        <Text size="sm">{t('listenTogether.connecting')}</Text>
                    )}

                    {status === 'connected' && (
                        <>
                            <Group justify="space-between" wrap="nowrap">
                                <Text ff="monospace" fw={700} size="xl">
                                    {code}
                                </Text>
                                {role === 'host' && code && (
                                    <CopyButton value={code}>
                                        {({ copied, copy }) => (
                                            <Button
                                                onClick={copy}
                                                size="compact-xs"
                                                variant="subtle"
                                            >
                                                {copied
                                                    ? t('listenTogether.copied')
                                                    : t('listenTogether.copy')}
                                            </Button>
                                        )}
                                    </CopyButton>
                                )}
                            </Group>
                            <Text isMuted size="xs">
                                {t('listenTogether.members', { count: members.length })}
                            </Text>
                            <Text size="sm">{members.map((m) => m.name).join(', ')}</Text>
                            {role === 'host' && (
                                <Switch
                                    checked={published}
                                    description={t('listenTogether.publicDescription')}
                                    label={t('listenTogether.public')}
                                    onChange={(e) => setPublished(e.currentTarget.checked)}
                                />
                            )}
                            <Button onClick={leaveSession} variant="default">
                                {t('listenTogether.leave')}
                            </Button>
                        </>
                    )}
                </Stack>
            </Popover.Dropdown>
        </Popover>
    );
};
