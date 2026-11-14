import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import styles from './added-by-column.module.css';

import {
    ColumnNullFallback,
    ItemTableListInnerColumn,
    TableColumnContainer,
} from '/@/renderer/components/item-list/item-table-list/item-table-list-column';
import { useCurrentServer } from '/@/renderer/store';
import { Icon } from '/@/shared/components/icon/icon';
import { Tooltip } from '/@/shared/components/tooltip/tooltip';
import { QueueSong } from '/@/shared/types/domain-types';
import { ServerType } from '/@/shared/types/types';

// Stable per-user color, so the same person always gets the same initial badge.
const hueFromName = (name: string) =>
    [...name].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) % 360, 0);

const UserAvatar = ({ name, userId }: { name: string; userId?: null | string }) => {
    const server = useCurrentServer();
    const [imageFailed, setImageFailed] = useState(false);

    // Jellyfin serves profile pictures without auth, so each client loads them from its
    // own server URL. Subsonic/Navidrome have no usable per-user pictures.
    const imageUrl =
        server?.type === ServerType.JELLYFIN && userId && !imageFailed
            ? `${server.url.replace(/\/+$/, '')}/UserImage?userId=${userId}`
            : null;

    if (imageUrl) {
        return (
            <img
                alt={name}
                className={styles.avatar}
                onError={() => setImageFailed(true)}
                src={imageUrl}
            />
        );
    }

    return (
        <span
            className={styles.avatar}
            style={{ backgroundColor: `hsl(${hueFromName(name)} 45% 40%)` }}
        >
            {name.charAt(0).toUpperCase()}
        </span>
    );
};

export const AddedByColumn = (props: ItemTableListInnerColumn) => {
    const { t } = useTranslation();
    const rowItem = (props.getRowItem?.(props.rowIndex) ??
        (props.data as unknown[])[props.rowIndex]) as QueueSong | undefined;
    const addedBy = rowItem?._addedBy;

    if (!addedBy) {
        return <ColumnNullFallback {...props} />;
    }

    return (
        <TableColumnContainer {...props}>
            <Tooltip
                label={
                    addedBy.autoDJ
                        ? t('listenTogether.addedByAutoDJ')
                        : t('listenTogether.addedBy', { name: addedBy.name })
                }
                openDelay={0}
            >
                {addedBy.autoDJ ? (
                    <span className={styles.autoDj}>
                        <Icon icon="wandSparkles" />
                    </span>
                ) : (
                    <span className={styles.wrapper}>
                        <UserAvatar name={addedBy.name} userId={addedBy.userId} />
                    </span>
                )}
            </Tooltip>
        </TableColumnContainer>
    );
};
