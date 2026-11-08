/** Browser half: the row's model picker on the plugin-manager page. */
import { createElement as h, useEffect, useState, type CSSProperties } from 'react'
import { MODEL_CATALOG, type ModelCatalogEntry } from './models.js'

/** Locale namespace for this browser half's copy. */
const NS = 'rapidspeech'

/** The row config slot key the plugin-manager page matches: `<package>#<row id>`. */
const ROW_KEY = 'dsh-plugin-rapidspeech#rapidspeech-asr'

/** The settings view snapshot this page consumes; `value` is the entry's composed config. */
interface FormSnapshot {
  readonly status: string
  readonly value?: {
    readonly modelId?: string
    readonly modelPath?: string
    readonly modelDownloadUrl?: string
  } | undefined
  readonly writable: boolean
  readonly revision?: number
  readonly error?: string | null
}

/** The `form` prop the plugin-manager passes to row config pages. */
interface FormProp {
  readonly state: FormSnapshot
  mutate(ops: ReadonlyArray<Record<string, unknown>>, expectedRevision?: number): Promise<boolean>
}

interface PageProps {
  readonly view?: string
  readonly form?: FormProp | undefined
}

/** Structural client runtime: the slots ledger and locale service this half touches. */
interface ClientContext {
  effect(factory: () => unknown, name?: string): unknown
  slots: {
    inject(slot: string, factory: () => unknown): unknown
    register(options: Record<string, unknown>, component: unknown): unknown
  }
  locale: {
    register(ns: string, dictionaries: Record<string, Record<string, string>>): unknown
    bind(ns: string): (key: string, params?: Record<string, string>) => string
  }
}

const zh = {
  title: '语音识别模型',
  hint: '点击切换目录模型：已缓存的模型数秒内完成切换，未缓存的模型会转入下载确认流程（见麦克风引导）。',
  loading: '正在读取配置…',
  rejected: '写入被拒绝：配置可能已在别处被修改，请重试。',
  unavailable: '此行当前不可编辑（行未运行或被更高层覆盖）。',
  customTitle: '自定义模型文件',
  customHint: '本机 GGUF 文件的绝对路径，设置后优先于目录模型；点击上方目录卡片可切回。',
  customPlaceholder: '/absolute/path/to/model.gguf',
  useFile: '使用此文件',
  usingCustom: '使用自定义模型',
  languages: '语言',
}

const en = {
  title: 'ASR model',
  hint: 'Click to switch catalog models: cached models swap within seconds, uncached ones enter the download consent flow (see the microphone guide).',
  loading: 'Reading configuration…',
  rejected: 'Write rejected: the configuration changed elsewhere, please retry.',
  unavailable: 'This row is not editable right now (not running, or overridden by a higher layer).',
  customTitle: 'Custom model file',
  customHint: 'Absolute path of a local GGUF file; it overrides the catalog models above. Click a card to switch back.',
  customPlaceholder: '/absolute/path/to/model.gguf',
  useFile: 'Use this file',
  usingCustom: 'Using a custom model',
  languages: 'Languages',
}

/** One ops array flipping the selection to a catalog entry; unsets yield to the catalog id. */
const catalogOps = (id: string) => [
  { op: 'unset', path: ['modelPath'] },
  { op: 'unset', path: ['modelDownloadUrl'] },
  { op: 'unset', path: ['modelSha256'] },
  { op: 'set', path: ['modelId'], value: id },
]

const styles: Record<string, CSSProperties> = {
  section: { display: 'flex', flexDirection: 'column', gap: 8, paddingBlock: 4 },
  title: { margin: 0, fontSize: 14, fontWeight: 600 },
  hint: { margin: 0, fontSize: 12, opacity: 0.72, lineHeight: 1.5 },
  cards: { display: 'flex', flexDirection: 'column', gap: 6 },
  card: {
    display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
    border: '1px solid color-mix(in srgb, currentColor 14%, transparent)',
    borderRadius: 8, background: 'transparent', textAlign: 'left', cursor: 'pointer', color: 'inherit',
  },
  cardSelected: {
    borderColor: 'color-mix(in srgb, currentColor 45%, transparent)',
    background: 'color-mix(in srgb, currentColor 6%, transparent)',
  },
  disabled: { cursor: 'default', opacity: 0.55 },
  cardMain: { flex: 1, minWidth: 0 },
  cardName: { fontSize: 13, fontWeight: 500 },
  cardMeta: { fontSize: 11, opacity: 0.66, marginTop: 2 },
  dot: {
    width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
    border: '1px solid color-mix(in srgb, currentColor 40%, transparent)',
  },
  dotOn: { background: 'currentColor' },
  row: { display: 'flex', gap: 8, alignItems: 'center' },
  input: {
    flex: 1, minWidth: 0, fontSize: 12, padding: '6px 10px', borderRadius: 8, color: 'inherit',
    border: '1px solid color-mix(in srgb, currentColor 20%, transparent)', background: 'transparent',
  },
  button: {
    fontSize: 12, padding: '6px 12px', borderRadius: 8, cursor: 'pointer', flexShrink: 0, color: 'inherit',
    border: '1px solid color-mix(in srgb, currentColor 30%, transparent)', background: 'transparent',
  },
  error: { margin: 0, fontSize: 12, color: 'crimson' },
  customCurrent: { fontSize: 11, opacity: 0.66, margin: 0, wordBreak: 'break-all' },
}

const megaBytes = (bytes: number): string => `${Math.round(bytes / 1024 / 1024)} MB`

/** Locale binding, installed once by `apply`; reads the live active locale on every call. */
let translate: (key: string) => string = key => (zh as Record<string, string>)[key] ?? key

function CatalogCard(props: {
  entry: ModelCatalogEntry
  selected: boolean
  disabled: boolean
  onSelect(): void
}): ReturnType<typeof h> {
  const { entry, selected, disabled, onSelect } = props
  return h('button', {
    type: 'button',
    disabled,
    style: { ...styles.card, ...(selected ? styles.cardSelected : {}), ...(disabled ? styles.disabled : {}) },
    onClick: onSelect,
    'aria-pressed': selected,
  },
    h('span', { style: { ...styles.dot, ...(selected ? styles.dotOn : {}) } }),
    h('span', { style: styles.cardMain },
      h('div', { style: styles.cardName }, entry.displayName),
      h('div', { style: styles.cardMeta },
        `${translate('languages')}: ${entry.languages.join(' / ')} · ${megaBytes(entry.bytes)} · sha256 ${entry.sha256?.slice(0, 8) ?? '—'}`),
    ),
  )
}

/** The row's config page: catalog model cards plus a custom GGUF path. */
function ModelConfigPage(props: PageProps): ReturnType<typeof h> | null {
  const { form, view } = props
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [customPath, setCustomPath] = useState('')
  const custom = form?.state.value?.modelPath ?? form?.state.value?.modelDownloadUrl
  // Mirror the effective custom path into the input; user edits take over from there.
  useEffect(() => { setCustomPath(custom ?? '') }, [custom])
  if (form === undefined) return null
  const { state } = form
  const value = state.value

  if (view === 'summary') {
    if (value === undefined) return null
    if (custom !== undefined) return h('span', null, `${translate('usingCustom')}: ${custom}`)
    return h('span', null,
      MODEL_CATALOG.find(entry => entry.id === (value.modelId ?? 'xasr-q8_0'))?.displayName ?? value.modelId ?? '')
  }

  if (state.status !== 'ready' || value === undefined) {
    return h('div', { style: styles.section },
      state.error !== undefined && state.error !== null ? state.error : translate('loading'))
  }

  const currentCatalogId = custom === undefined ? value.modelId ?? 'xasr-q8_0' : undefined
  const disabled = pending || !state.writable

  const write = async (ops: ReadonlyArray<Record<string, unknown>>): Promise<void> => {
    setPending(true)
    setFailure(null)
    try {
      const accepted = await form.mutate(ops, state.revision)
      if (!accepted) setFailure(translate('rejected'))
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }

  const children: Array<ReturnType<typeof h> | null> = [
    h('h3', { key: 'title', style: styles.title }, translate('title')),
    h('p', { key: 'hint', style: styles.hint }, !state.writable ? translate('unavailable') : translate('hint')),
    h('div', { key: 'cards', style: styles.cards },
      MODEL_CATALOG.map(entry => h(CatalogCard, {
        key: entry.id,
        entry,
        selected: entry.id === currentCatalogId,
        disabled,
        onSelect: () => { void write(catalogOps(entry.id)) },
      })),
    ),
    h('h3', { key: 'custom-title', style: styles.title }, translate('customTitle')),
    h('p', { key: 'custom-hint', style: styles.hint }, translate('customHint')),
  ]
  if (custom !== undefined) {
    children.push(h('p', { key: 'custom-current', style: styles.customCurrent }, `${translate('usingCustom')}: ${custom}`))
  }
  children.push(
    h('div', { key: 'custom-row', style: styles.row },
      h('input', {
        style: styles.input,
        value: customPath,
        placeholder: translate('customPlaceholder'),
        disabled,
        spellCheck: false,
        onChange: (event: { target: { value: string } }) => { setCustomPath(event.target.value) },
      }),
      h('button', {
        type: 'button',
        style: { ...styles.button, ...(disabled ? styles.disabled : {}) },
        disabled,
        onClick: () => {
          const path = customPath.trim()
          if (path.length > 0) void write([{ op: 'set', path: ['modelPath'], value: path }])
        },
      }, translate('useFile')),
    ),
    failure !== null ? h('p', { key: 'failure', style: styles.error }, failure) : null,
  )
  return h('div', { style: styles.section }, children)
}

/**
 * Mount the browser half: register the copy, then contribute the row config page.
 * @param ctx - client runtime with the slots ledger and locale service.
 */
export function apply(ctx: ClientContext): void {
  translate = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }))
  ctx.effect(() => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
    name: 'plugins.row.config',
    key: ROW_KEY,
    locale: NS,
  }, ModelConfigPage)))
}

/** Services this half waits for before mounting. */
export const inject = ['slots', 'locale']
