import { useEffect, useState } from 'react';
import { useImportStore, type ImportItem, type ImportStage } from '../../importer/importStore.ts';

const STAGE_LABEL: Record<ImportStage, string> = {
  queued: 'Waiting…',
  parsing: 'Reading file…',
  validating: 'Checking rig…',
  'needs-slot': 'Which animation is this?',
  'installing-anim': 'Installing animation…',
  converting: 'Converting to GLB…',
  uploading: 'Saving to office…',
  conflict: 'Name taken',
  done: 'Done',
  error: 'Failed',
};

/** parsing → converting → uploading progress fraction for the bar */
const STAGE_PROGRESS: Partial<Record<ImportStage, number>> = {
  queued: 0.05,
  parsing: 0.25,
  validating: 0.3,
  'installing-anim': 0.7,
  converting: 0.55,
  uploading: 0.85,
  done: 1,
};

/** Mixamo's character browser, with the Characters type pre-selected */
const MIXAMO_CHARACTERS_URL = 'https://www.mixamo.com/#/?page=1&type=Character';

/** The canonical skeleton to build a Blender character on; see docs/blender-characters.md */
const TEMPLATE_URL = '/models/characters/_lib/Rig_Medium_Template.glb';

const mixamoSearch = (query: string) =>
  `https://www.mixamo.com/#/?page=1&type=Motion%2CMotionPack&query=${encodeURIComponent(query)}`;

export function ImportPanel() {
  const { items, animStatus, refreshAnimStatus, addFiles, clearFinished } = useImportStore();
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    refreshAnimStatus();
  }, [refreshAnimStatus]);

  const animsReady = !!animStatus?.sit && !!animStatus?.idle;
  const hasFinished = items.some((i) => i.stage === 'done' || i.stage === 'error');

  return (
    <div style={styles.wrap}>
      <div
        style={{ ...styles.dropZone, ...(dragging ? styles.dropZoneActive : {}) }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          addFiles([...e.dataTransfer.files]);
        }}
      >
        <div style={{ fontSize: 22 }}>⬇</div>
        <div style={{ fontWeight: 600 }}>Drop a Blender .glb or a Mixamo .fbx here</div>
        <div style={styles.hint}>
          Made in Blender? Export as glTF Binary on the office rig template — the rig is checked as it lands.{' '}
          <a href={TEMPLATE_URL} download style={styles.hintLink}>
            Download the rig template ↗
          </a>
        </div>
        <div style={styles.hint}>
          {animsReady ? (
            <>From Mixamo: any character downloaded as "FBX Binary", with skin.</>
          ) : (
            <>
              First Mixamo import: download{' '}
              <a href={mixamoSearch('Sitting Idle')} target="_blank" rel="noreferrer" style={styles.hintLink}>
                Sitting Idle
              </a>{' '}
              and{' '}
              <a href={mixamoSearch('Idle')} target="_blank" rel="noreferrer" style={styles.hintLink}>
                Idle
              </a>{' '}
              from Mixamo (Format: FBX, Skin: Without Skin) and drop them here. Then drop any character.
            </>
          )}
        </div>
        <a href={MIXAMO_CHARACTERS_URL} target="_blank" rel="noreferrer" style={styles.mixamoLink}>
          Browse characters on Mixamo ↗
        </a>
        <label style={styles.browse}>
          browse files
          <input
            type="file"
            accept=".fbx,.glb"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              addFiles([...(e.target.files ?? [])]);
              e.target.value = '';
            }}
          />
        </label>
      </div>

      <div style={styles.animRow}>
        <AnimChip label="Mixamo sitting animation" ok={!!animStatus?.sit} />
        <AnimChip label="Mixamo idle animation" ok={!!animStatus?.idle} />
      </div>

      {items.length > 0 && (
        <div style={styles.queue}>
          {items.map((it) => (
            <ImportRow key={it.key} item={it} />
          ))}
          {hasFinished && (
            <button style={styles.clear} onClick={clearFinished}>
              clear finished
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function AnimChip({ label, ok }: { label: string; ok: boolean }) {
  return (
    <span style={{ ...styles.animChip, borderColor: ok ? '#2e5c37' : '#4a3f2c', color: ok ? '#8fd19a' : '#d8b46a' }}>
      {ok ? '✓' : '○'} {label}
    </span>
  );
}

function ImportRow({ item }: { item: ImportItem }) {
  const { assignSlot, renameAndRetry } = useImportStore();
  const [rename, setRename] = useState(item.displayName);
  const progress = STAGE_PROGRESS[item.stage];
  const isError = item.stage === 'error';
  const isDone = item.stage === 'done';

  return (
    <div style={styles.row}>
      <div style={styles.rowTop}>
        <span style={styles.fileName}>{item.fileName}</span>
        <span style={{ ...styles.stage, color: isError ? '#e08585' : isDone ? '#8fd19a' : '#9ab4d0' }}>
          {STAGE_LABEL[item.stage]}
        </span>
      </div>

      {progress !== undefined && !isDone && (
        <div style={styles.barTrack}>
          <div style={{ ...styles.barFill, width: `${progress * 100}%` }} />
        </div>
      )}

      {item.stage === 'needs-slot' && (
        <div style={styles.actions}>
          <button style={styles.actionBtn} onClick={() => assignSlot(item.key, 'sit')}>
            Use as Sitting
          </button>
          <button style={styles.actionBtn} onClick={() => assignSlot(item.key, 'idle')}>
            Use as Idle
          </button>
        </div>
      )}

      {item.stage === 'conflict' && (
        <div style={styles.actions}>
          <input
            style={styles.renameInput}
            value={rename}
            onChange={(e) => setRename(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') renameAndRetry(item.key, rename);
            }}
          />
          <button style={styles.actionBtn} onClick={() => renameAndRetry(item.key, rename)}>
            Import
          </button>
        </div>
      )}

      {item.detail && <div style={{ ...styles.detail, color: isError ? '#e08585' : '#9aa4b0' }}>{item.detail}</div>}
      {item.warnings.map((w, i) => (
        <div key={i} style={{ ...styles.detail, color: '#d8b46a' }}>⚠ {w}</div>
      ))}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto', minHeight: 0 },
  dropZone: {
    border: '2px dashed #2c333d', borderRadius: 10, padding: '18px 14px',
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
    textAlign: 'center', color: '#c7cdd4', fontSize: 13, transition: 'border-color 0.15s, background 0.15s',
  },
  dropZoneActive: { borderColor: '#5a8fd0', background: 'rgba(90,143,208,0.08)' },
  hint: { fontSize: 12, color: '#9aa4b0', maxWidth: 380, lineHeight: 1.5 },
  hintLink: { color: '#9ab4d0' },
  mixamoLink: {
    marginTop: 6, fontSize: 13, fontWeight: 600, color: '#9ab4d0',
    textDecoration: 'none', border: '1px solid #2c4258', background: '#1c2733',
    borderRadius: 6, padding: '5px 12px',
  },
  browse: {
    marginTop: 4, fontSize: 12, color: '#9ab4d0', textDecoration: 'underline',
    cursor: 'pointer',
  },
  animRow: { display: 'flex', gap: 8 },
  animChip: {
    fontSize: 11, padding: '3px 10px', borderRadius: 10, border: '1px solid',
    background: '#0e1116',
  },
  queue: { display: 'flex', flexDirection: 'column', gap: 8 },
  row: {
    background: '#0e1116', border: '1px solid #2c333d', borderRadius: 8,
    padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13,
  },
  rowTop: { display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline' },
  fileName: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
  stage: { fontSize: 12, whiteSpace: 'nowrap' },
  barTrack: { height: 4, borderRadius: 2, background: '#1c222b', overflow: 'hidden' },
  barFill: { height: '100%', background: '#5a8fd0', borderRadius: 2, transition: 'width 0.3s' },
  actions: { display: 'flex', gap: 8, alignItems: 'center' },
  actionBtn: {
    background: '#1c2733', border: '1px solid #2c4258', color: '#cfe0f2',
    borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer',
  },
  renameInput: {
    flex: 1, background: '#161a20', border: '1px solid #2c333d', color: '#e6e8eb',
    borderRadius: 6, padding: '4px 8px', fontSize: 13,
  },
  detail: { fontSize: 12, lineHeight: 1.4 },
  clear: {
    alignSelf: 'flex-end', background: 'none', border: 'none', color: '#9aa4b0',
    fontSize: 12, cursor: 'pointer', textDecoration: 'underline',
  },
};
