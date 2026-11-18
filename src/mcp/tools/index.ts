import type { ToolDefinition } from '../registry.js';
import { readTools } from './chats.js';
import { fileTools } from './files.js';
import { sendTools } from './send.js';

export const allTools: ToolDefinition[] = [...readTools, ...fileTools, ...sendTools] as ToolDefinition[];
