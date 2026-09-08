import { describe, expect, it } from 'vitest';
import { parseIssueForm } from '../src/issue-form.ts';

const body = `### Repository URL

https://github.com/someone/omarchy-nujabes-theme

### Theme name

Nujabes

### Before you submit

- [X] The preview and backgrounds contain no personal information.
- [ ] Something optional

### Anything else?

_No response_
`;

describe('parseIssueForm', () => {
	it('reads fields by label', () => {
		const f = parseIssueForm(body);
		expect(f.repo).toBe('https://github.com/someone/omarchy-nujabes-theme');
		expect(f.name).toBe('Nujabes');
		expect(f.checks['The preview and backgrounds contain no personal information.']).toBe(true);
		expect(f.checks['Something optional']).toBe(false);
	});

	it('treats unfilled fields as null', () => {
		const f = parseIssueForm('### Repository URL\n\n_No response_\n\n### Theme name\n\n\n');
		expect(f.repo).toBeNull();
		expect(f.name).toBeNull();
	});

	it('keeps only the first line of a value and handles CRLF', () => {
		const f = parseIssueForm('### Repository URL\r\n\r\nhttps://github.com/a/b\r\nextra\r\n');
		expect(f.repo).toBe('https://github.com/a/b');
	});

	it('handles a body that is not a form', () => {
		const f = parseIssueForm('hello');
		expect(f).toEqual({ repo: null, name: null, checks: {} });
	});
});
