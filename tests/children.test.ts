import { expect, test } from 'claude-code/testing'
import { childOwner, childThread, MAX_CHILDREN, projectChildren } from '../hooks/children'
import { LiveActivity } from '../hooks/activity'
import type { CodexAgent } from '../types'

const parent = (patch: Partial<CodexAgent> = {}) => ({ id: 'wrapper', threadId: 'parent', currentTurnId: 'parent-turn', lastTurnId: null, ...patch } as CodexAgent)
const collab = (ids: string[], patch: Record<string, unknown> = {}) => ({ threadId: 'parent', turnId: 'parent-turn', item: {
  type: 'collabAgentToolCall', senderThreadId: 'parent', receiverThreadIds: ids, tool: 'spawnAgent',
  agentsStates: Object.fromEntries(ids.map(id => [id, { status: 'running', message: null }])), ...patch,
} })

test('child discovery uses real parent/source and collaboration metadata; forks and foreign roots do not qualify', () => {
  expect(childThread({ thread: { id: 'child', forkedFromId: 'parent' } })).toBe(null)
  const params = { thread: { id: 'child', source: { subAgent: { thread_spawn: { parent_thread_id: 'parent', agent_nickname: 'Reviewer', depth: 1 } } } } }
  expect(childThread(params)).toEqual({ id: 'child', parent: 'parent', name: 'Reviewer' })
  const projected = projectChildren(parent(), 'thread/started', params)
  const job = parent({ children: projected.children })
  expect(childOwner({ wrapper: job }, 'child')?.id).toBe('wrapper')
  expect(childOwner({ wrapper: job }, 'foreign')).toBeUndefined()
  const nested = projectChildren(job, 'thread/started', { thread: { id: 'grandchild', parentThreadId: 'child', agentNickname: 'Nested' } })
  expect(nested.children[1]).toMatchObject({ parentThreadId: 'child', name: 'Nested' })
})

test('children are bounded and sanitized, ignore non-spawn peers and never retain prompts or raw data', () => {
  const data = collab(Array.from({ length: MAX_CHILDREN + 10 }, (_, i) => `c-${i}`), { prompt: 'PRIVATE', agentsStates: { 'c-0': { status: 'running', message: `TOKEN=secret ${'x'.repeat(2000)}` } } })
  const result = projectChildren(parent(), 'item/completed', data)
  expect(result.children).toHaveLength(MAX_CHILDREN)
  expect(result.children[0]?.message.length <= 500).toBe(true)
  expect(JSON.stringify(result)).not.toMatch(/secret|PRIVATE|prompt/)
  expect(projectChildren(parent(), 'item/completed', collab(['peer'], { tool: 'sendInput' })).children).toEqual([])
  expect(projectChildren(parent(), 'item/completed', collab(['c'], { senderThreadId: 'foreign' })).children).toEqual([])
})

test('child progress and terminal status require the current child turn and never replace the parent turn', () => {
  let job = parent({ children: projectChildren(parent(), 'item/completed', collab(['child'])).children })
  const apply = (method: string, params: Record<string, unknown>) => {
    const result = projectChildren(job, method, { threadId: 'child', ...params })
    job = { ...job, children: result.children }
    return result
  }
  apply('turn/started', { turn: { id: 'child-turn' } })
  apply('thread/status/changed', { status: { type: 'idle' } })
  expect(job.children?.[0]?.status).toBe('idle')
  apply('thread/status/changed', { status: { type: 'active', activeFlags: [] } })
  apply('item/completed', { turnId: 'old', item: { type: 'agentMessage', text: 'STALE' } })
  expect(job.children?.[0]?.message).toBe('')
  apply('item/completed', { turnId: 'child-turn', item: { type: 'agentMessage', text: 'Checking\nnow\u202e.' } })
  expect(job.children?.[0]?.message).toBe('Checking now .')
  apply('turn/completed', { turn: { id: 'old', status: 'failed' } })
  expect(job.children?.[0]?.status).toBe('running')
  apply('turn/completed', { turn: { id: 'child-turn', status: 'failed' } })
  expect(job.children?.[0]?.status).toBe('errored')
  apply('thread/status/changed', { status: { type: 'idle' } })
  expect(job.children?.[0]?.status).toBe('errored')
  expect(apply('turn/started', { turn: { id: 'child-turn' } }).changed).toEqual([])
  expect(job.currentTurnId).toBe('parent-turn')
  job = { ...job, currentTurnId: 'next-parent-turn' }
  apply('turn/started', { turn: { id: 'next-child-turn' } })
  expect(job.children?.[0]?.ownerTurnId).toBe('next-parent-turn')
  apply('turn/completed', { turn: { id: 'next-child-turn', status: 'interrupted' } })
  expect(job.children?.[0]?.status).toBe('interrupted')
})

test('subAgentActivity lifecycle and collaboration snapshots update known children including shutdown', () => {
  const activity = { threadId: 'parent', turnId: 'parent-turn', item: { type: 'subAgentActivity', agentThreadId: 'child', agentPath: '/root/reviewer', kind: 'started' } }
  const job = parent({ children: projectChildren(parent(), 'item/completed', activity).children })
  expect(job.children?.[0]).toMatchObject({ name: '/root/reviewer', status: 'running' })
  const result = projectChildren(job, 'item/completed', collab(['child'], { tool: 'closeAgent', agentsStates: { child: { status: 'shutdown', message: 'Stopped.' } } }))
  expect(result.children[0]).toMatchObject({ status: 'shutdown', message: 'Stopped.' })
  const resumed = parent({ currentTurnId: 'next-parent-turn', children: job.children })
  expect(projectChildren(resumed, 'item/completed', { ...activity, item: { ...activity.item, kind: 'interacted' } }).children[0]?.ownerTurnId).toBe('next-parent-turn')
})

test('child sendMessage progress is projected while input and spawn prompts remain private', () => {
  const job = parent({ children: projectChildren(parent(), 'item/completed', collab(['child'])).children })
  const message = { threadId: 'child', item: { type: 'collabAgentToolCall', senderThreadId: 'child', receiverThreadIds: ['parent'], tool: 'sendMessage', prompt: 'Tests passed. TOKEN=secret', agentsStates: {} } }
  const result = projectChildren(job, 'item/completed', message)
  expect(result.children[0]?.message).toBe('Tests passed. TOKEN=[redacted]')
  for (const tool of ['spawnAgent', 'sendInput', 'followupTask']) {
    expect(projectChildren(job, 'item/completed', { ...message, item: { ...message.item, tool, prompt: 'PRIVATE' } }).children[0]?.message).toBe('')
  }
})

test('child receipt queues dedupe, sanitize and fence parent turns with bounded overflow', () => {
  const feed = new LiveActivity()
  feed.begin('parent', 'turn')
  feed.child('parent', 'old', 'c', 'STALE', 'running', 'STALE')
  for (let i = 0; i < 2; i++) feed.child('parent', 'turn', 'c', 'Reviewer', 'running', 'Checking TOKEN=secret')
  expect(feed.take('parent', 'turn')).toEqual([{ kind: 'command', command: '↳ Reviewer: Checking TOKEN=[redacted]', result: 'running' }])
  for (let i = 0; i < 100; i++) feed.child('parent', 'turn', `c${i}`, `Child ${i}`, 'running', 'x'.repeat(2000))
  const batch = feed.take('parent', 'turn')
  expect(batch[0]).toEqual({ kind: 'text', text: '[40 older Codex activity entries omitted]' })
  expect(JSON.stringify(batch).length < 16_000).toBe(true)
})
