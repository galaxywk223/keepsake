import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AudioLines, Check, Grid2X2, Images, LayoutList, Play, RefreshCw, Search, Trash2, X } from 'lucide-react'
import { useDeferredValue, useMemo, useState } from 'react'
import { api } from '../api'
import { formatBytes, platformLabel } from '../format'
import type { Collection } from '../types'
import { MediaViewer } from './MediaViewer'

type ViewMode = 'grid' | 'list'

export function LibraryPage() {
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search)
  const [mediaType, setMediaType] = useState('all')
  const [sort, setSort] = useState('newest')
  const [view, setView] = useState<ViewMode>('grid')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [viewer, setViewer] = useState<string | null>(null)
  const query = useMemo(() => {
    const params = new URLSearchParams({ search: deferredSearch, media_type: mediaType, sort })
    return params
  }, [deferredSearch, mediaType, sort])
  const library = useQuery({ queryKey: ['library', deferredSearch, mediaType, sort], queryFn: () => api.library(query) })
  const action = useMutation({
    mutationFn: ({ name, ids }: { name: 'trash'; ids: string[] }) => api.libraryAction(name, ids),
    onSuccess: () => {
      setSelected(new Set())
      void queryClient.invalidateQueries({ queryKey: ['library'] })
    },
  })
  const rescan = useMutation({
    mutationFn: api.rescan,
    onSuccess: () => window.setTimeout(() => void queryClient.invalidateQueries({ queryKey: ['library'] }), 700),
  })

  const toggle = (id: string) => {
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <section className="library-page">
      <div className="library-toolbar">
        <label className="search-field">
          <Search size={17} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索媒体" aria-label="搜索媒体" />
          {search ? <button onClick={() => setSearch('')} type="button" aria-label="清空搜索"><X size={15} /></button> : null}
        </label>
        <div className="segmented-control" aria-label="媒体类型">
          {[['all', '全部'], ['image', '图片'], ['video', '视频'], ['audio', '音频']].map(([value, label]) => (
            <button className={mediaType === value ? 'is-active' : ''} key={value} onClick={() => setMediaType(value)} type="button">{label}</button>
          ))}
        </div>
        <select value={sort} onChange={(event) => setSort(event.target.value)} aria-label="排序">
          <option value="newest">最新添加</option>
          <option value="oldest">最早添加</option>
          <option value="name">名称</option>
          <option value="size">文件数量</option>
        </select>
        <span className="toolbar-spacer" />
        <div className="view-toggle">
          <button className={view === 'grid' ? 'is-active' : ''} onClick={() => setView('grid')} type="button" aria-label="网格视图"><Grid2X2 size={17} /></button>
          <button className={view === 'list' ? 'is-active' : ''} onClick={() => setView('list')} type="button" aria-label="列表视图"><LayoutList size={18} /></button>
        </div>
        <button className="icon-button bordered" onClick={() => rescan.mutate()} type="button" aria-label="重新扫描">
          <RefreshCw size={17} className={rescan.isPending ? 'spin' : ''} />
        </button>
      </div>

      <div className="library-summary">
        <strong>{library.data?.total ?? 0} 个作品</strong>
        {library.isFetching ? <span>正在同步</span> : <span>已同步本地目录</span>}
      </div>

      {library.error ? <p className="inline-error">{library.error.message}</p> : null}
      {!library.isLoading && !library.data?.items.length ? (
        <div className="card empty-state library-empty">
          <span className="empty-icon"><Images size={28} /></span>
          <h2>{search ? '没有匹配的媒体' : '媒体库为空'}</h2>
          <p>{search ? '调整搜索或筛选条件' : '下载或放入文件后重新扫描'}</p>
        </div>
      ) : null}

      <div className={`media-collection ${view === 'list' ? 'is-list' : 'is-grid'}`}>
        {(library.data?.items ?? []).map((item) => (
          <MediaItem
            item={item}
            key={item.id}
            selected={selected.has(item.id)}
            view={view}
            onSelect={() => toggle(item.id)}
            onOpen={() => setViewer(item.id)}
          />
        ))}
      </div>

      {selected.size ? (
        <div className="selection-bar">
          <strong>{selected.size} 项已选择</strong>
          <button className="text-button" onClick={() => setSelected(new Set())} type="button"><X size={15} />取消选择</button>
          <button className="danger-button" onClick={() => action.mutate({ name: 'trash', ids: [...selected] })} type="button"><Trash2 size={16} />移入回收站</button>
        </div>
      ) : null}

      <MediaViewer collectionId={viewer} onClose={() => setViewer(null)} />
    </section>
  )
}

interface MediaItemProps {
  item: Collection
  selected: boolean
  view: ViewMode
  onSelect: () => void
  onOpen: () => void
}

function MediaItem({ item, selected, view, onSelect, onOpen }: MediaItemProps) {
  const date = new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(new Date(item.created_at))
  return (
    <article className={`media-item ${selected ? 'is-selected' : ''}`}>
      <button className="media-preview" onClick={onOpen} type="button" aria-label={`预览 ${item.title}`}>
        {item.cover_asset_id ? <img src={`oml-media://asset/${item.cover_asset_id}/thumbnail`} alt="" loading="lazy" /> : <span><Images size={28} /></span>}
        {item.media_type === 'video' || item.media_type === 'mixed' ? <i className="play-indicator"><Play size={13} fill="currentColor" /></i> : null}
        {item.media_type === 'audio' ? <i className="play-indicator"><AudioLines size={14} /></i> : null}
        {item.item_count > 1 ? <span className="item-count"><Images size={12} />{item.item_count}</span> : null}
      </button>
      <button className="item-selector" onClick={onSelect} type="button" aria-label={selected ? '取消选择' : '选择'}>
        {selected ? <Check size={14} strokeWidth={3} /> : null}
      </button>
      <div className="media-caption" onClick={onOpen} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter') onOpen() }}>
        <strong title={item.title}>{item.title}</strong>
        <span>{item.author || (item.imported ? '本地文件' : platformLabel(item.platform))} · {date}</span>
        {view === 'list' ? <small>{formatBytes(item.total_size)} · {item.item_count} 个文件</small> : null}
      </div>
    </article>
  )
}

