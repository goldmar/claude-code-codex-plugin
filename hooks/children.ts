// Projections of Codex 0.162.1's generated app-server v2 types. No prompts,
// raw reasoning, command output or arbitrary protocol objects enter the registry.
import type { CodexAgent, CodexChild } from '../types'
import { redactActivity } from './activity'

export const MAX_CHILDREN = 64
export const CHILD_STATUSES = ['pendingInit', 'running', 'interrupted', 'completed', 'errored', 'shutdown', 'notFound', 'idle', 'unknown'] as const
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const idOf = (value: unknown): string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value) ? value : ''
const statusOf = (value: unknown): CodexChild['status'] | undefined => CHILD_STATUSES.includes(value as CodexChild['status']) ? value as CodexChild['status'] : undefined

export function childOwner(agents: Record<string, CodexAgent>, threadId: string): CodexAgent | undefined {
  return Object.values(agents).find(agent => agent.threadId === threadId || agent.children?.some(child => child.threadId === threadId))
}

/** All relationship discovery is anchored in an already owned thread. A fork
 * alone is not a child; use parentThreadId or the actual subAgent source. */
export function childThread(params: Record<string, unknown>): { id: string; parent: string; name: string } | null {
  const thread = object(params.thread)
  const spawn = object(object(object(thread.source).subAgent).thread_spawn)
  const id = idOf(thread.id), parent = idOf(thread.parentThreadId) || idOf(spawn.parent_thread_id)
  if (!id || !parent || id === parent) return null
  const name = thread.agentNickname ?? spawn.agent_nickname ?? thread.agentRole ?? spawn.agent_role
  return { id, parent, name: typeof name === 'string' ? redactActivity(name, 80) : '' }
}

export function childLinks(method: string, params: Record<string, unknown>): { id: string; parent: string }[] {
  if (method === 'thread/started') {
    const thread = childThread(params)
    return thread ? [thread] : []
  }
  if (!['item/started', 'item/completed'].includes(method)) return []
  const item = object(params.item), parent = idOf(params.threadId)
  if (!parent) return []
  if (item.type === 'collabAgentToolCall' && item.tool === 'spawnAgent' && item.senderThreadId === parent && Array.isArray(item.receiverThreadIds)) {
    return item.receiverThreadIds.slice(0, MAX_CHILDREN).map(idOf).filter(id => id && id !== parent).map(id => ({ id, parent }))
  }
  if (item.type === 'subAgentActivity' && idOf(item.agentThreadId) && item.agentThreadId !== parent) return [{ id: idOf(item.agentThreadId), parent }]
  return []
}

/** Return changed sanitized descendants only. Existing turn IDs fence stale
 * child items/completions; parent-turn ownership fences replay across resumes. */
export function projectChildren(agent: CodexAgent, method: string, params: Record<string, unknown>): { children: CodexChild[]; changed: CodexChild[] } {
  const children = (agent.children ?? []).map(child => ({ ...child }))
  const changed: CodexChild[] = []
  const ownerTurnId = agent.currentTurnId ?? agent.lastTurnId
  const upsert = (id: string, parent: string, patch: Partial<CodexChild>, discover = true) => {
    if (!id || id === agent.threadId || !parent || id === parent) return
    // Never reparent an existing descendant based on another agent's tool call.
    let child = children.find(child => child.threadId === id)
    if (child && child.parentThreadId !== parent) return
    if (!child) {
      if (!discover || children.length >= MAX_CHILDREN) return
      child = { threadId: id, parentThreadId: parent, name: `child-${children.length + 1}`, status: 'pendingInit', message: '', ownerTurnId, currentTurnId: null, lastTurnId: null }
      children.push(child)
    }
    const before = JSON.stringify(child)
    Object.assign(child, patch)
    child.name = redactActivity(child.name, 80) || 'child'
    child.message = redactActivity(child.message, 500)
    if (before !== JSON.stringify(child) || !agent.children?.some(old => old.threadId === id)) changed.push(child)
  }
  if (method === 'thread/started') {
    const thread = childThread(params)
    if (thread) upsert(thread.id, thread.parent, thread.name ? { name: thread.name } : {})
    return { children, changed }
  }
  const sourceId = idOf(params.threadId)
  const source = children.find(child => child.threadId === sourceId)
  const turn = object(params.turn)
  const eventTurn = idOf(params.turnId) || idOf(turn.id)
  if (source && eventTurn) {
    if (method === 'turn/started') {
      if (source.lastTurnId === eventTurn || (source.currentTurnId && source.currentTurnId !== eventTurn)) return { children, changed }
      upsert(sourceId, source.parentThreadId, { status: 'running', currentTurnId: eventTurn, ownerTurnId })
    } else if (source.currentTurnId !== eventTurn) return { children, changed }
  }
  const item = object(params.item)
  if (['item/started', 'item/completed'].includes(method) && item.type === 'collabAgentToolCall') {
    if (item.senderThreadId !== sourceId) return { children, changed }
    const states = object(item.agentsStates)
    const receivers = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.slice(0, MAX_CHILDREN) : []
    for (const receiver of receivers) {
      const id = idOf(receiver), state = object(states[id])
      const known = children.find(child => child.threadId === id)
      const status = statusOf(state.status)
      upsert(id, known?.parentThreadId ?? sourceId, {
        ownerTurnId,
        ...(status ? { status } : {}),
        ...(typeof state.message === 'string' ? { message: state.message } : {}),
      }, item.tool === 'spawnAgent')
    }
  } else if (method === 'item/completed' && item.type === 'subAgentActivity') {
    const states: Record<string, CodexChild['status']> = { started: 'running', interacted: 'running', interrupted: 'interrupted', completed: 'completed' }
    const id = idOf(item.agentThreadId), known = children.find(child => child.threadId === id)
    const status = states[String(item.kind)]
    if (status) upsert(id, known?.parentThreadId ?? sourceId, {
      ownerTurnId, status, ...(typeof item.agentPath === 'string' ? { name: item.agentPath } : {}),
    })
  }
  if (source) {
    if (method === 'item/completed' && item.type === 'collabAgentToolCall' && item.tool === 'sendMessage' && typeof item.prompt === 'string') {
      // This field is a child's outgoing message for sendMessage only. Spawn,
      // follow-up and input prompts remain excluded from the display projection.
      upsert(sourceId, source.parentThreadId, { message: item.prompt })
    } else if (method === 'item/completed' && item.type === 'agentMessage' && typeof item.text === 'string') {
      upsert(sourceId, source.parentThreadId, { message: item.text })
    } else if (method === 'turn/completed') {
      const status = turn.status === 'failed' ? 'errored' : statusOf(turn.status)
      if (status) upsert(sourceId, source.parentThreadId, { status, currentTurnId: null, lastTurnId: eventTurn })
    } else if (method === 'thread/status/changed') {
      const type = object(params.status).type
      // Idle/unload is not proof of completion. Preserve confirmed terminal
      // outcomes, otherwise report idle as observed rather than claiming work.
      const status = type === 'active' ? 'running' : type === 'systemError' ? 'errored'
        : type === 'idle' && ['running', 'pendingInit', 'unknown'].includes(source.status) ? 'idle' : undefined
      if (status) upsert(sourceId, source.parentThreadId, { status })
    } else if (method === 'thread/closed' && ['running', 'pendingInit'].includes(source.status)) {
      upsert(sourceId, source.parentThreadId, { status: 'unknown', currentTurnId: null })
    }
  }
  return { children, changed }
}
