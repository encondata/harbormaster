import type { z } from 'zod';
import { badRequest } from './errors.js';

// "contact_email" -> "Contact email"
const label = (path: PropertyKey[]) => {
  const s = path.map(String).join(' ').replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
};

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    const msg = r.error.issues
      .map((i) => {
        if (!i.path.length) return i.message;
        const name = label(i.path);
        // Our own messages already name the field ("Last name is required"); zod's defaults don't.
        return i.message.toLowerCase().startsWith(name.toLowerCase()) ? i.message : `${name}: ${i.message}`;
      })
      .join('; ');
    throw badRequest(msg);
  }
  return r.data;
}
