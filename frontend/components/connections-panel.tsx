"use client"

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"
import { createPortal } from "react-dom"
import { DotGlyph } from "@/components/dot-glyph"
import { ServiceIcon } from "@/components/service-icon"
import { SERVICES, backendOrigin, integrationRequest, safeWebUrl, type Connection, type RemoteItem, type Service, type ServiceId, type Source, type Task } from "@/lib/integrations"
import { calendarFile, downloadFile, parseTaskFile, taskCsv, taskMarkdown } from "@/lib/task-files"

interface Props { tasks: Task[]; onImport: (tasks: Task[]) => void; onClose: () => void }
const GROUPS = ["All", "Tasks", "Calendars", "Messages", "Notes & files", "Automation"] as const
const errorText = (error: unknown) => error instanceof Error ? error.message : "Something got tangled. Try again."

export function ConnectionsPanel({ tasks, onImport, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [connections, setConnections] = useState<Connection[]>([])
  const [service, setService] = useState<Service | null>(null)
  const [group, setGroup] = useState<(typeof GROUPS)[number]>("All")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)
  const refresh = useCallback(async () => {
    try {
      const data = await integrationRequest<{ services: Connection[] }>()
      setConnections(data.services); setError("")
    } catch (e) { setError(errorText(e)) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => {
    const active = document.activeElement as HTMLElement | null
    const element = dialog.current
    element?.showModal()
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    void refresh()
    const connected = (event: MessageEvent) => {
      if (event.origin === backendOrigin() && event.data?.type === "lofai:integration-connected") void refresh()
    }
    window.addEventListener("message", connected)
    window.addEventListener("focus", refresh)
    return () => {
      window.removeEventListener("message", connected)
      window.removeEventListener("focus", refresh)
      document.body.style.overflow = previousOverflow
      element?.close(); active?.focus({ preventScroll: true })
    }
  }, [refresh])

  return createPortal(
    <dialog ref={dialog} className="connections-dialog" aria-labelledby="connections-title" onCancel={onClose} onClick={(event) => {
      if (event.target === event.currentTarget) {
        const rect = event.currentTarget.getBoundingClientRect()
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose()
      }
    }}>
      <header className="connections-header">
        <div><p className="eyebrow">Little connections</p><h2 id="connections-title">Bring your world in.</h2><p>A few things from elsewhere. A little room to focus.</p></div>
        <button type="button" className="key connections-close" onClick={onClose} aria-label="Close connections"><DotGlyph name="cross" dot={2} /></button>
      </header>
      <div className="connections-body dot-scroll">
        {service ? (
          <>
            <button type="button" className="connection-back" onClick={() => setService(null)}>← All connections</button>
            <ServiceDetail key={service.id} service={service} connection={connections.find((c) => c.id === service.id)} tasks={tasks} onImport={onImport} onRefresh={refresh} />
          </>
        ) : (
          <>
            <div className="connection-filters" role="group" aria-label="Filter services">
              {GROUPS.map((name) => <button type="button" key={name} aria-pressed={group === name} onClick={() => setGroup(name)}>{name}</button>)}
            </div>
            {error && <p className="connection-notice" role="status">{error} <button type="button" onClick={() => { setLoading(true); void refresh() }}>Try again</button> Files and notebook exports work here too.</p>}
            <div className="connection-grid" aria-busy={loading}>
              {SERVICES.filter((s) => group === "All" || s.group === group).map((entry) => {
                const state = connections.find((c) => c.id === entry.id)
                return <button type="button" key={entry.id} className="connection-card" onClick={() => setService(entry)}>
                  <ServiceIcon service={entry.id} />
                  <span><strong>{entry.name}</strong><span className="connection-card-note">{entry.description}</span></span>
                  <span className={`connection-badge${state?.connected ? " is-connected" : ""}`}>{entry.portable ? "Ready" : state?.connected ? (entry.group === "Automation" ? "Configured" : "Connected") : "Set up"}</span>
                </button>
              })}
            </div>
            <p className="connection-footnote">You choose what comes over. Imported copies stay on this device; completion sync is optional.</p>
          </>
        )}
      </div>
    </dialog>, document.body,
  )
}

function ServiceDetail({ service, connection, tasks, onImport, onRefresh }: { service: Service; connection?: Connection; tasks: Task[]; onImport: Props["onImport"]; onRefresh: () => Promise<void> }) {
  const [token, setToken] = useState("")
  const [extra, setExtra] = useState("")
  const [resource, setResource] = useState("")
  const [sources, setSources] = useState<Source[]>([])
  const [source, setSource] = useState("")
  const [items, setItems] = useState<RemoteItem[]>([])
  const [cursor, setCursor] = useState<string | undefined>()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [sync, setSync] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [loaded, setLoaded] = useState(false)
  const [sendId, setSendId] = useState(tasks[0]?.id ?? "")
  const requestVersion = useRef(0)
  const path = `/${service.id}`
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(""); setNotice("")
    try { await action() } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }

  const loadSources = useCallback(async () => {
    const version = ++requestVersion.current
    setBusy(true); setError("")
    try {
      const data = await integrationRequest<{ sources: Source[] }>(`${path}/sources`)
      if (version !== requestVersion.current) return
      setSources(data.sources); setSource(data.sources[0]?.id ?? ""); setItems([]); setSelected(new Set()); setLoaded(false); setCursor(undefined)
    } catch (e) { if (version === requestVersion.current) setError(errorText(e)) }
    finally { if (version === requestVersion.current) setBusy(false) }
  }, [path])

  useEffect(() => {
    if (connection?.connected && service.group !== "Automation") void loadSources()
    return () => { requestVersion.current++ }
  }, [connection?.connected, service.group, loadSources])

  const connect = (event: FormEvent) => {
    event.preventDefault()
    void run(async () => {
      await integrationRequest(path, { method: "PUT", body: JSON.stringify({ token: service.id === "apple-reminders" ? "native" : token.trim(), extra: extra.trim(), resource: resource.trim() }) })
      setToken(""); setExtra(""); await onRefresh()
      setNotice(service.group === "Automation" ? "Webhook saved. Choose a task to send when you're ready." : "Connected. Pick a little something to bring over.")
    })
  }

  const loadItems = (more = false) => void run(async () => {
    const query = new URLSearchParams({ source })
    if (more && cursor) query.set("cursor", cursor)
    const data = await integrationRequest<{ items: RemoteItem[]; nextCursor?: string }>(`${path}/items?${query}`)
    setItems((current) => Array.from(new Map([...(more ? current : []), ...data.items].map((item) => [item.id, item])).values()))
    setCursor(data.nextCursor || undefined); setLoaded(true)
    if (!more) setSelected(new Set())
  })

  const importSelected = () => {
    const chosen = items.filter((item) => selected.has(item.id))
    onImport(chosen.map((item) => ({
      id: crypto.randomUUID(), text: item.title, done: item.done,
      source: { provider: service.id, source, id: item.id, url: safeWebUrl(item.url), sync: Boolean(sync && service.complete && item.kind === "task" && item.canComplete !== false) },
    })))
    setNotice(`${chosen.length} ${chosen.length === 1 ? "thing" : "things"} brought onto the desk. Make yourself comfortable.`)
    setSelected(new Set())
  }

  return <section className="connection-detail" aria-label={service.name}>
    <div className="connection-detail-title"><ServiceIcon service={service.id} /><div><h3>{service.name}</h3><p>{service.description}</p></div></div>
    {service.portable ? <PortableTools service={service.id} tasks={tasks} onImport={onImport} /> : <>
      {connection?.connected ? (
        <div className="connection-connected"><span className="connection-badge is-connected">{service.group === "Automation" ? "Configured" : "Connected"}</span><button type="button" disabled={busy} onClick={() => void run(async () => {
          await integrationRequest(path, { method: "DELETE" }); setItems([]); setSources([]); setLoaded(false); await onRefresh(); setNotice("Disconnected. Tasks already on your desk stay here.")
        })}>Disconnect</button></div>
      ) : <form onSubmit={connect} className="connection-form">
        {connection?.oauthConfigured && <button type="button" className="key connection-primary" disabled={busy} onClick={() => {
          const popup = window.open("about:blank", "lofai-connect", "width=540,height=720")
          void run(async () => {
            try {
              const data = await integrationRequest<{ url: string }>(`${path}/oauth`, { method: "POST" })
              if (popup) popup.location.href = data.url
              else throw new Error("Allow pop-ups to connect your account, then try again.")
              setNotice("Finish connecting in the account window.")
            } catch (e) { popup?.close(); throw e }
          })
        }}>Connect account</button>}
        {service.id === "apple-reminders" ? <p className="connection-hint">On your Mac, allow the local server to access Reminders when macOS asks. Your lists will appear here.</p> : <>
          <label>{service.tokenLabel}<input type="password" value={token} onChange={(e) => setToken(e.target.value)} required autoComplete="off" spellCheck={false} maxLength={8192} /></label>
          {service.extraLabel && <label>{service.extraLabel}<input type="password" value={extra} onChange={(e) => setExtra(e.target.value)} required autoComplete="off" spellCheck={false} /></label>}
          {service.resourceLabel && <label>{service.resourceLabel}<input value={resource} onChange={(e) => setResource(e.target.value)} required={service.resourceRequired} autoComplete="off" spellCheck={false} /></label>}
          <p className="connection-hint">{service.group === "Automation" ? "Saved on your local server. Nothing is sent until you choose Send task." : "Credentials stay on your local server. Access tokens may expire; reconnect when needed."} <a href={service.docs} target="_blank" rel="noreferrer">Setup guide ↗</a></p>
        </>}
        <button type="submit" className="key connection-primary" disabled={busy}>{busy ? "Connecting…" : service.group === "Automation" ? "Save webhook" : "Connect"}</button>
      </form>}

      {connection?.connected && service.group === "Automation" && <div className="connection-form">
        <p className="connection-hint">Send one task to your workflow. Its title, completion state, and source link will be included.</p>
        <label>Task to send<select value={sendId} onChange={(e) => setSendId(e.target.value)}><option value="">Choose a task</option>{tasks.map((task) => <option key={task.id} value={task.id}>{task.text}</option>)}</select></label>
        <button type="button" className="key connection-primary" disabled={busy || !tasks.some((task) => task.id === sendId)} onClick={() => void run(async () => {
          const task = tasks.find((t) => t.id === sendId)
          if (!task) return
          await integrationRequest(`${path}/send`, { method: "POST", body: JSON.stringify({ title: task.text, done: task.done, url: safeWebUrl(task.source?.url) }) })
          setNotice("Delivered to your webhook.")
        })}>{busy ? "Sending…" : "Send task"}</button>
      </div>}

      {connection?.connected && service.group !== "Automation" && <div className="connection-browser">
        <div className="connection-source-row"><label>Choose a list or source<select value={source} disabled={busy || sources.length === 0} onChange={(event) => { setSource(event.target.value); setItems([]); setCursor(undefined); setSelected(new Set()); setLoaded(false); setNotice("") }}>
          {sources.length === 0 && <option value="">No sources found</option>}{sources.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </select></label><button type="button" className="key" disabled={busy || !source} onClick={() => loadItems()}>{loaded ? "Refresh" : "Browse"}</button></div>
        {!sources.length && !busy && <p className="connection-hint">No shared lists or sources yet. Check the account's access, then <button type="button" onClick={() => void loadSources()}>refresh sources</button>.</p>}
        {loaded && items.length === 0 && <p className="connection-empty">{cursor ? "Nothing to bring over on this page. There may be more on the next." : "A quiet little corner. Nothing to bring over here."}</p>}
        {cursor && <button type="button" className="connection-more" disabled={busy} onClick={() => loadItems(true)}>Bring the next page into view</button>}
        {items.length > 0 && <>
          <div className="connection-selection"><span>{selected.size} selected</span><button type="button" onClick={() => setSelected(selected.size === items.length ? new Set() : new Set(items.map((item) => item.id)))}>{selected.size === items.length ? "Select none" : "Select shown"}</button></div>
          <ul className="connection-items dot-scroll">{items.map((item) => <li key={item.id}>
            <label><input type="checkbox" checked={selected.has(item.id)} onChange={(event) => setSelected((previous) => { const next = new Set(previous); if (event.target.checked) next.add(item.id); else next.delete(item.id); return next })} />
              <span><span className={item.done ? "connection-item-done" : ""}>{item.title}</span>{item.due && <small>{item.kind === "event" ? "Starts " : "Due "}{formatDate(item.due)}</small>}</span>
            </label>{safeWebUrl(item.url) && <a href={safeWebUrl(item.url)} target="_blank" rel="noreferrer" aria-label={`Open ${item.title} in ${service.name}`}>↗</a>}
          </li>)}</ul>
          {service.complete && <label className="connection-sync"><input type="checkbox" checked={sync} onChange={(e) => setSync(e.target.checked)} />Also update completion in {service.name}</label>}
          {sync && service.id === "trello" && <p className="connection-hint">Updates the card's completion checkbox. The card stays in its list.</p>}
          {sync && service.id === "notion" && <p className="connection-hint">Sync uses a single checkbox named Done, Complete, or Completed. Pages without one come over as local copies.</p>}
          <p className="connection-hint">{sync ? "Checking or reopening these tasks here will update the original too. Refresh and import again to bring changes made there onto the desk." : "Bring over local copies. Refresh and import again to update their titles; your local completion stays yours."}</p>
          <button type="button" className="key connection-primary" disabled={busy || !selected.size} onClick={importSelected}>Bring {selected.size || "a little something"} onto the desk</button>
        </>}
      </div>}
    </>}
    {busy && <p className="connection-progress" role="status">A moment, gathering things…</p>}
    {error && <p className="connection-error" role="alert">{error}</p>}
    {notice && <p className="connection-notice" role="status">{notice}</p>}
  </section>
}

function formatDate(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(`${value}T12:00:00`).toLocaleDateString()
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : value
}

function PortableTools({ service, tasks, onImport }: { service: ServiceId; tasks: Task[]; onImport: Props["onImport"] }) {
  const [preview, setPreview] = useState<Task[]>([])
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [vault, setVault] = useState("")
  const [note, setNote] = useState("A little list from lofAI")
  const [title, setTitle] = useState("A little focus time")
  const [start, setStart] = useState("")
  const [minutes, setMinutes] = useState(25)
  const obsidian = `obsidian://new?${new URLSearchParams({ name: note, content: taskMarkdown(tasks), ...(vault.trim() ? { vault: vault.trim() } : {}) })}`
  return <div className="connection-form">
    {service === "files" && <>
      <label className="connection-file">Import a checklist<input type="file" accept=".json,.csv,.md,.txt" onChange={async (event) => {
        setError(""); setNotice(""); setPreview([])
        const file = event.target.files?.[0]
        if (!file) return
        try { if (file.size > 1_000_000) throw new Error("Choose a file under 1 MB."); setPreview(parseTaskFile(file.name, await file.text())) } catch (e) { setError(errorText(e)) }
        event.target.value = ""
      }} /></label>
      <p className="connection-hint">JSON task arrays, CSV with text/done columns, or Markdown checklists. Preview before adding.</p>
      {preview.length > 0 && <><ul className="connection-items dot-scroll">{preview.map((task) => <li key={task.id}>{task.done ? "✓ " : "· "}{task.text}</li>)}</ul><button type="button" className="key" onClick={() => { onImport(preview); setNotice(`${preview.length} tasks brought over.`); setPreview([]) }}>Import {preview.length} tasks</button></>}
      <div className="connection-export-row"><button type="button" className="key" onClick={() => downloadFile("lofai-tasks.json", JSON.stringify(tasks.map(({ id, text, done }) => ({ id, text, done })), null, 2), "application/json")}>Export JSON</button><button type="button" className="key" onClick={() => downloadFile("lofai-tasks.csv", taskCsv(tasks), "text/csv")}>Export CSV</button><button type="button" className="key" onClick={() => downloadFile("lofai-tasks.md", taskMarkdown(tasks), "text/markdown")}>Export Markdown</button></div>
    </>}
    {service === "obsidian" && <>
      <p className="connection-hint">Create a note in your installed Obsidian app, or take a Markdown copy with you. Each export is a snapshot.</p>
      <label>Vault name (optional)<input value={vault} onChange={(e) => setVault(e.target.value)} maxLength={120} /></label>
      <label>Note name<input value={note} onChange={(e) => setNote(e.target.value)} maxLength={120} /></label>
      <div className="connection-export-row">{obsidian.length < 8000 && note.trim() && <a className="key" href={obsidian}>Open in Obsidian ↗</a>}<button type="button" className="key" onClick={() => downloadFile("lofai-tasks.md", taskMarkdown(tasks), "text/markdown")}>Save Markdown</button></div>
    </>}
    {service === "apple-calendar" && <form className="connection-form" onSubmit={(event) => {
      event.preventDefault(); setError("")
      try { downloadFile("lofai-focus.ics", calendarFile(title, new Date(start), minutes), "text/calendar"); setNotice("Focus block downloaded. Open it to add it to your calendar.") } catch (e) { setError(errorText(e)) }
    }}>
      <p className="connection-hint">Make a calendar file for Apple Calendar, Google Calendar, or Outlook. Open the download to add the event.</p>
      <label>Make room for<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required /></label>
      <label>Start (your local time)<input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} required /></label>
      <label>Minutes<input type="number" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} min={1} max={1440} required /></label>
      <button type="submit" className="key connection-primary">Save a focus block</button>
    </form>}
    {error && <p className="connection-error" role="alert">{error}</p>}{notice && <p className="connection-notice" role="status">{notice}</p>}
  </div>
}
