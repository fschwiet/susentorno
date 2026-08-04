import { describe, it, expect } from 'vitest';
import { parseBlockListFile } from '../../src/blockList';

describe('block-list parsing', () => {
  it('parses bare hostnames, one per line', () => {
    const content = ['self.events.data.microsoft.com', '*.doubleclick.net', ''].join('\n');
    expect(parseBlockListFile(content)).toEqual({
      entries: ['self.events.data.microsoft.com', '*.doubleclick.net'],
      warnings: [],
    });
  });

  it('ignores blank lines and comment lines', () => {
    const content = ['# a comment', '', 'self.events.data.microsoft.com', ''].join('\n');
    expect(parseBlockListFile(content)).toEqual({
      entries: ['self.events.data.microsoft.com'],
      warnings: [],
    });
  });

  it('dedupes repeated entries', () => {
    const content = ['self.events.data.microsoft.com', 'self.events.data.microsoft.com', ''].join(
      '\n',
    );
    expect(parseBlockListFile(content)).toEqual({
      entries: ['self.events.data.microsoft.com'],
      warnings: [],
    });
  });

  it('warns and drops an entry with a port suffix', () => {
    const content = ['self.events.data.microsoft.com:443', ''].join('\n');
    expect(parseBlockListFile(content)).toEqual({
      entries: [],
      warnings: [
        "block-list entries are bare hostnames, no port: excluded 'self.events.data.microsoft.com:443'",
      ],
    });
  });

  it('accepts a single leading *.host wildcard', () => {
    expect(parseBlockListFile('*.doubleclick.net\n')).toEqual({
      entries: ['*.doubleclick.net'],
      warnings: [],
    });
  });

  it('warns and drops a **.host wildcard instead of normalizing it', () => {
    const content = ['**.doubleclick.net', 'ads.example.com', ''].join('\n');
    expect(parseBlockListFile(content)).toEqual({
      entries: ['ads.example.com'],
      warnings: ["unsupported wildcard syntax, excluded: '**.doubleclick.net'"],
    });
  });

  it('warns and drops a mid-string wildcard', () => {
    expect(parseBlockListFile('bad*.example.com\n')).toEqual({
      entries: [],
      warnings: ["unsupported wildcard syntax, excluded: 'bad*.example.com'"],
    });
  });
});
