import { describe, expect, it } from 'vitest';
import { toolLabel } from './toolLabels';

describe('toolLabel', () => {
  it('switches tense between running and finished', () => {
    expect(toolLabel('run_bash', { command: 'ls' }, true).label).toBe('Running a command');
    expect(toolLabel('run_bash', { command: 'ls' }, false).label).toBe('Ran a command');
  });

  it('ignores the MCP server prefix', () => {
    expect(toolLabel('sandbox__read_file', { path: 'a.ts' }, false)).toMatchObject({ label: 'Read a file', detail: 'a.ts' });
  });

  it('shows the host of a URL, and survives a malformed one', () => {
    expect(toolLabel('web_fetch', { url: 'https://www.example.com/a/b?q=1' }, false).detail).toBe('example.com');
    expect(toolLabel('web_fetch', { url: 'not a url' }, false).detail).toBe('not a url');
    expect(toolLabel('web_fetch', { url: 'x'.repeat(80) }, false).detail).toBe(`${'x'.repeat(40)}…`);
  });

  it('collapses whitespace and clips long details', () => {
    const d = toolLabel('run_bash', { command: 'echo   a\n\nb' }, false).detail;
    expect(d).toBe('echo a b');
    expect(toolLabel('run_bash', { command: 'z'.repeat(100) }, false).detail).toBe(`${'z'.repeat(60)}…`);
  });

  it('has no detail when the argument is missing, blank or not a string', () => {
    expect(toolLabel('read_file', undefined, false).detail).toBeUndefined();
    expect(toolLabel('read_file', { path: '   ' }, false).detail).toBeUndefined();
    expect(toolLabel('read_file', { path: 7 }, false).detail).toBeUndefined();
  });

  it('falls back to the raw name for a tool it does not know', () => {
    expect(toolLabel('crm__find_contact', {}, false).label).toBe('crm__find_contact');
  });
});
