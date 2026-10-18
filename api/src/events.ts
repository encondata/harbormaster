import { EventEmitter } from 'node:events';

// In-process change feed. Every write publishes here; SSE clients subscribe per project.
export type ChangeEvent = { projectId: string; type: string; boardId?: string; cardId?: string; actor?: string };

export const bus = new EventEmitter();
bus.setMaxListeners(0);

export function publish(e: ChangeEvent) {
  bus.emit('change', e);
}
