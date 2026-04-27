/**
 * Build a pruned semantic view of interactive DOM elements and inject stable AI ids.
 * Aggressively limits payload size:
 *  - <select> and combobox options are hard-capped at MAX_OPTIONS (5).
 *  - Elements that already carry a value are flagged so the agent can skip them.
 *  - All SVGs, hidden nodes, and extra whitespace are stripped before reading text.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<Array<{ai_id: string, type: string, label: string, currentValue?: string, options?: string[]}>>}
 */
async function getSimplifiedDOM(page) {
	if (!page || typeof page.evaluate !== 'function') {
		throw new Error('getSimplifiedDOM requires a valid Playwright page instance.');
	}

	const simplifiedElements = await page.evaluate(() => {
		const MAX_OPTIONS = 5;
		const MAX_LABEL_CHARS = 100;

		// ─── Selectors ────────────────────────────────────────────────────────
		const selector = [
			'input:not([type="hidden"])',
			'textarea',
			'button',
			'select',
			'div[role="combobox"]',
			'span[role="combobox"]',
			'div[role="listbox"]',
			'span[role="listbox"]',
			'div[role="button"]',
			'span[role="button"]'
		].join(',');

		// ─── Helpers ──────────────────────────────────────────────────────────
		const isHidden = (el) => {
			if (!el) return true;
			if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true;
			let cur = el;
			while (cur && cur.nodeType === Node.ELEMENT_NODE) {
				const s = window.getComputedStyle(cur);
				if (s.display === 'none' || s.visibility === 'hidden') return true;
				cur = cur.parentElement;
			}
			return false;
		};

		const normalizeText = (v) =>
			typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL_CHARS) : '';

		/** Strip SVG / icons / hidden children, return trimmed text. */
		const cleanText = (el) => {
			if (!el || isHidden(el)) return '';
			const clone = el.cloneNode(true);
			clone
				.querySelectorAll(
					'svg,path,i,icon,use,[hidden],[aria-hidden="true"],[style*="display:none"],[style*="display: none"],[style*="visibility:hidden"],[style*="visibility: hidden"]'
				)
				.forEach((n) => n.remove());
			return normalizeText(clone.textContent || '');
		};

		const nearbyText = (el) => {
			if (el.id) {
				const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
				if (lbl) { const t = cleanText(lbl); if (t) return t; }
			}
			const closest = el.closest('label');
			if (closest) { const t = cleanText(closest); if (t) return t; }
			const parent = el.parentElement ? cleanText(el.parentElement) : '';
			if (parent) return parent;
			const prev = el.previousElementSibling ? cleanText(el.previousElementSibling) : '';
			if (prev) return prev;
			return el.nextElementSibling ? cleanText(el.nextElementSibling) : '';
		};

		const getLabel = (el) => {
			const placeholder = normalizeText(el.getAttribute('placeholder'));
			if (placeholder) return placeholder;
			const name = normalizeText(el.getAttribute('name'));
			if (name) return name;
			const aria = normalizeText(el.getAttribute('aria-label'));
			if (aria) return aria;
			const own = cleanText(el);
			if (own) return own;
			return nearbyText(el);
		};

		/** Cap an array of option strings at MAX_OPTIONS, appending a summary tail. */
		const capOptions = (raw) => {
			const opts = raw.map(normalizeText).filter(Boolean);
			if (opts.length <= MAX_OPTIONS) return opts;
			const extra = opts.length - MAX_OPTIONS;
			return [...opts.slice(0, MAX_OPTIONS), `...and ${extra} more`];
		};

		const selectOptions = (el) => {
			if (el.tagName.toLowerCase() !== 'select') return [];
			const opts = Array.from(el.querySelectorAll('option'))
				.filter((o) => !o.disabled && !isHidden(o))
				.map((o) => o.label || o.textContent || o.value || '');
			return capOptions(opts);
		};

		const comboboxOptions = (el) => {
			const role = normalizeText(el.getAttribute('role'));
			if (role !== 'combobox' && role !== 'listbox') return [];
			let pool = Array.from(el.querySelectorAll('[role="option"],option,li'));
			if (!pool.length) {
				const cid = el.getAttribute('aria-controls');
				if (cid) {
					const ctrl = document.getElementById(cid);
					if (ctrl)
						pool = Array.from(ctrl.querySelectorAll('[role="option"],option,li,div,span'));
				}
			}
			return capOptions(pool.filter((o) => !isHidden(o)).map(cleanText).filter(Boolean));
		};

		/** Read the element's current filled value so the agent can skip completed fields. */
		const getCurrentValue = (el) => {
			const tag = el.tagName.toLowerCase();
			if (tag === 'select') {
				return el.selectedOptions.length
					? normalizeText(el.selectedOptions[0].label || el.selectedOptions[0].text || '')
					: '';
			}
			if (tag === 'input' || tag === 'textarea') {
				return normalizeText(el.value || '');
			}
			// ARIA combobox – try aria-activedescendant label or innerText
			const aria = normalizeText(el.getAttribute('aria-activedescendant') || '');
			if (aria) return aria;
			return cleanText(el);
		};

		// ─── Main Loop ────────────────────────────────────────────────────────
		const candidates = Array.from(document.querySelectorAll(selector));
		let counter = 0;
		const result = [];

		for (const el of candidates) {
			if (isHidden(el) || el.hasAttribute('disabled')) continue;

			counter += 1;
			const aiId = `ai-${counter}`;
			el.setAttribute('data-ai-id', aiId);

			const tagOrRole =
				normalizeText(el.getAttribute('role')) || el.tagName.toLowerCase();
			const label = getLabel(el);
			const currentValue = getCurrentValue(el);
			const options = [
				...selectOptions(el),
				...comboboxOptions(el)
			].slice(0, MAX_OPTIONS + 1); // belt-and-suspenders cap

			const entry = { ai_id: aiId, type: tagOrRole, label };
			if (currentValue) entry.currentValue = currentValue;
			if (options.length) entry.options = options;

			result.push(entry);
		}

		return result;
	});

	return simplifiedElements;
}

module.exports = { getSimplifiedDOM };
