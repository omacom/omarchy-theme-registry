/**
 * Parse the body of an issue created from `.github/ISSUE_TEMPLATE/submit-theme.yml`.
 *
 * GitHub renders every form field as `### <label>` followed by the value, so we key the
 * result by label. Unfilled optional fields render as `_No response_`.
 */

export const ISSUE_FORM_FIELDS = {
	repo: 'Repository URL',
	name: 'Theme name'
} as const;

export interface IssueFormFields {
	repo: string | null;
	name: string | null;
	/** every checkbox in the form, by its text, true when ticked */
	checks: Record<string, boolean>;
}

export function parseIssueForm(body: string): IssueFormFields {
	const sections = new Map<string, string>();
	const re = /^###\s+(.+?)\s*$/gm;
	const heads: { label: string; start: number; end: number }[] = [];
	for (let m = re.exec(body); m; m = re.exec(body))
		heads.push({ label: m[1]!, start: m.index, end: m.index + m[0].length });
	heads.forEach((h, i) => {
		const next = heads[i + 1];
		sections.set(h.label, body.slice(h.end, next ? next.start : body.length).trim());
	});

	const value = (label: string): string | null => {
		const v = sections.get(label)?.trim();
		if (!v || v === '_No response_') return null;
		return v.split('\n')[0]!.trim();
	};

	const checks: Record<string, boolean> = {};
	for (const m of body.matchAll(/^\s*- \[([ xX])\]\s+(.+?)\s*$/gm))
		checks[m[2]!] = m[1]!.toLowerCase() === 'x';

	return {
		repo: value(ISSUE_FORM_FIELDS.repo),
		name: value(ISSUE_FORM_FIELDS.name),
		checks
	};
}
