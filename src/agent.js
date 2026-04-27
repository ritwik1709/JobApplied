const Groq = require('groq-sdk');
const { chromium } = require('playwright');

const { getSimplifiedDOM } = require('./domParser');
const { ResumeMemory } = require('./rag');

// ─── Constants ────────────────────────────────────────────────────────────────
/** Maximum empty elements to send per LLM call (keeps payload tiny). */
const CHUNK_SIZE = 5;

/**
 * llama3-8b-8192: 8 k context, fast, reliable JSON mode on Groq free tier.
 * Do NOT change to compound/preview models – they reject json_object format.
 */
const GROQ_MODEL = 'llama-3.1-8b-instant';
//const GROQ_MODEL = 'llama-3.3-70b-versatile';

const GROQ_MAX_RETRIES = Number(process.env.GROQ_MAX_RETRIES || 2);
const GROQ_RETRY_DELAY_MS = Number(process.env.GROQ_RETRY_DELAY_MS || 2000);

// ─── Singletons ───────────────────────────────────────────────────────────────
const resumeMemory = new ResumeMemory();
let isResumeLoaded = false;

/** Lazy Groq client – only instantiated when GROQ_API_KEY is available (set by dotenv). */
let _groqClient = null;
function getGroqClient() {
	if (!_groqClient) {
		_groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
	}
	return _groqClient;
}

// ─── Utilities ────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isTransientError(error) {
	const status = error?.status || error?.response?.status;
	if (status && status >= 500) return true;
	const combined = `${error?.message || ''} ${error?.cause?.message || ''}`.toLowerCase();
	return (
		combined.includes('connection error') ||
		combined.includes('fetch failed') ||
		combined.includes('econnreset') ||
		combined.includes('etimedout') ||
		combined.includes('network')
	);
}

// ─── Payload Filters ──────────────────────────────────────────────────────────

/** Returns true for any element that is a button/submit control (never needs a text value). */
function isButtonElement(el) {
	const t = (el.type || '').toLowerCase();
	// type comes from tagName or role — catch every button variant
	const BUTTON_TYPES = new Set([
		'button', 'submit',
		'div[role="button"]', 'span[role="button"]',
		'button[role="button"]', 'a[role="button"]'
	]);
	if (BUTTON_TYPES.has(t)) return true;
	// Also catch label text that looks like submit buttons
	const label = (el.label || '').toLowerCase();
	const SUBMIT_LABELS = ['submit', 'apply', 'next', 'continue', 'send', 'finish', 'done'];
	if (t === 'button' || t === 'input') {
		return SUBMIT_LABELS.some((s) => label.includes(s));
	}
	return false;
}

/**
 * Strip buttons and already-filled fields, then return at most CHUNK_SIZE elements.
 * The LLM should NEVER see button/submit elements — submit is handled separately
 * by the main loop once all fields are confirmed complete.
 *
 * @param {Array<{ai_id:string, type:string, label:string, currentValue?:string}>} domElements
 * @param {Set<string>} filledIds  Agent-side truth: IDs we have already successfully actioned.
 * @returns {Array}
 */
function buildPayloadChunk(domElements, filledIds = new Set()) {
	const empty = domElements.filter((el) => {
		if (isButtonElement(el)) return false;
		if (filledIds.has(el.ai_id)) return false;
		if (el.currentValue && el.currentValue.trim()) return false;
		return true;
	});
	return empty.slice(0, CHUNK_SIZE);
}

// ─── Reasoning Engine ─────────────────────────────────────────────────────────
/**
 * Determine the next automation action using Groq LLM reasoning.
 *
 * Changes vs. previous version:
 *  1. Filters out already-filled fields before sending.
 *  2. Sends only CHUNK_SIZE (5) elements at a time.
 *  3. Uses `llama3-8b-8192` which supports json_object on the free tier.
 *  4. Wrapped in try/catch that logs exact error and returns null safely.
 *
 * @param {Array<{ai_id:string, type:string, label:string}>} simplifiedDOM
 * @param {string} jobGoal
 * @returns {Promise<{action:string, ai_id:string, value:string|null}|null>}
 */
async function determineNextAction(simplifiedDOM, jobGoal,userData) {
	if (!process.env.GROQ_API_KEY) {
		console.error('[Groq] GROQ_API_KEY is missing – cannot call reasoning engine.');
		return null;
	}

	// ── Payload reduction ──────────────────────────────────────────────────
	const chunk = buildPayloadChunk(Array.isArray(simplifiedDOM) ? simplifiedDOM : []);

	if (!chunk.length) {
		console.log('[Agent] No unfilled elements found – nothing to reason about.');
		return null;
	}

	console.log(
		`[Agent] Sending ${chunk.length}/${simplifiedDOM.length} elements to Groq (model: ${GROQ_MODEL}).`
	);

	// ── Prompts ────────────────────────────────────────────────────────────
	const systemPrompt = [
        'You are an expert automated job applicant agent.',
        'Evaluate the provided simplified DOM chunk and the Applicant Profile to choose the single best immediate next UI action.',
        'Return ONLY a valid JSON object with this exact schema:',
        '{"action":"<click | type_text | select_dropdown | submit | answer_complex_field | upload_file>","ai_id":"<target-id>","value":"<text to type>"}',
        'Rules:',
        '- action must be exactly one of: click, type_text, select_dropdown, submit, answer_complex_field, upload_file.',
        '- ai_id must match one of the provided ai_id values in the DOM chunk.',
        '- For "type_text", pull the exact matching information from the provided Applicant Profile.',
        '- For "select_dropdown", set the value to the closest matching option text.',
        '- For "upload_file", trigger this strictly for file input fields (e.g., Resume, CV upload). Leave the value empty.',
        '- For "answer_complex_field", trigger this ONLY for open-ended essay questions. Leave the value empty.',
        '- CRITICAL GUARDRAIL: NEVER use the "submit" action unless the element label explicitly says "Submit", "Apply", or "Send".',
        '- value must be an empty string when action is "click", "submit", "answer_complex_field", or "upload_file".',
        '- Output strictly valid JSON. Do not include explanations.'
    ].join('\n');

	const userPrompt = [
		`Job Goal: ${jobGoal || ''}`,
		'--- APPLICANT PROFILE ---',
		JSON.stringify(userData || {}, null, 2),
		'--- SIMPLIFIED DOM CHUNK (unfilled fields only, max 5) ---',
		JSON.stringify(chunk, null, 2)
	].join('\n');

	const messages = [
		{ role: 'system', content: systemPrompt },
		{ role: 'user', content: userPrompt }
	];

	// ── API call with retry ────────────────────────────────────────────────
	try {
		for (let attempt = 0; attempt <= GROQ_MAX_RETRIES; attempt += 1) {
			try {
				const response = await getGroqClient().chat.completions.create({
					model: GROQ_MODEL,
					messages,
					response_format: { type: 'json_object' }
				});

				const jsonContent = response?.choices?.[0]?.message?.content;
				if (typeof jsonContent !== 'string' || !jsonContent.trim()) {
					throw new Error('Groq returned an empty or invalid JSON payload.');
				}

				return JSON.parse(jsonContent);
			} catch (innerError) {
				const isLast = attempt >= GROQ_MAX_RETRIES;

				// Log the exact raw error for debugging
				const rawDetails =
					innerError?.error ||
					innerError?.response?.data ||
					innerError?.message ||
					innerError;
				console.error(
					`[Groq] Attempt ${attempt + 1}/${GROQ_MAX_RETRIES + 1} failed:`,
					JSON.stringify(rawDetails, null, 2)
				);

				if (!isLast && isTransientError(innerError)) {
					const delay = GROQ_RETRY_DELAY_MS * (attempt + 1);
					console.warn(`[Groq] Transient error – retrying in ${delay}ms…`);
					await sleep(delay);
					continue;
				}

				// Non-retryable or exhausted retries → return null, do NOT crash
				return null;
			}
		}
	} catch (outerError) {
		// Safety net – should not normally be reached
		console.error('[Groq] Unexpected outer error:', outerError?.message || outerError);
	}

	return null;
}

// ─── React-aware fill helper ──────────────────────────────────────────────────
/**
 * Fills an input and then dispatches native input+change events so React's
 * synthetic event system registers the new value and flushes state immediately.
 * Without this, React controlled inputs may still report empty on the next
 * DOM parse, causing the agent to loop on the same field.
 *
 * @param {import('playwright').Page} page
 * @param {string} selector
 * @param {string} text
 */
async function reactFill(page, selector, text) {
	await page.fill(selector, text);
	await page.evaluate((sel) => {
		const el = document.querySelector(sel);
		if (!el) return;
		// Use the setter that matches the element type; cross-calling setters causes Illegal invocation.
		let nativeValueSetter;
		const tag = el.tagName?.toLowerCase();

		if (tag === 'textarea') {
			nativeValueSetter = Object.getOwnPropertyDescriptor(
				window.HTMLTextAreaElement.prototype,
				'value'
			)?.set;
		} else if (tag === 'input') {
			nativeValueSetter = Object.getOwnPropertyDescriptor(
				window.HTMLInputElement.prototype,
				'value'
			)?.set;
		} else {
			nativeValueSetter = Object.getOwnPropertyDescriptor(
				Object.getPrototypeOf(el),
				'value'
			)?.set;
		}

		if (nativeValueSetter) {
			nativeValueSetter.call(el, el.value);
		}
		el.dispatchEvent(new Event('input', { bubbles: true }));
		el.dispatchEvent(new Event('change', { bubbles: true }));
	}, selector);
}

// ─── Main Application Loop ────────────────────────────────────────────────────
/**
 * Orchestrate the observe → reason → act loop for a single job application.
 *
 * @param {string} jobUrl
 * @param {Record<string, unknown>} userData
 * @returns {Promise<void>}
 */
async function processJobApplication(jobUrl, userData) {
	let browser;

	try {
		browser = await chromium.launch({ headless: false });
		const page = await browser.newPage();

		// Raise all Playwright timeouts globally – ATS pages can be slow.
		page.setDefaultTimeout(60000);
		page.setDefaultNavigationTimeout(60000);

		// Navigate with automatic retry so a one-off network hiccup doesn't kill the run.
		const NAV_RETRIES = 3;
		let navSuccess = false;
		for (let navAttempt = 1; navAttempt <= NAV_RETRIES; navAttempt++) {
			try {
				await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
				navSuccess = true;
				break;
			} catch (navErr) {
				console.warn(
					`[Agent] Navigation attempt ${navAttempt}/${NAV_RETRIES} failed: ${navErr.message}`
				);
				if (navAttempt === NAV_RETRIES) throw navErr; // re-throw on last attempt
				await page.waitForTimeout(3000 * navAttempt); // back-off before retry
			}
		}
		if (!navSuccess) return; // guard (unreachable, but safe)

		if (!isResumeLoaded) {
			await resumeMemory.loadResume('./resume.pdf');
			isResumeLoaded = true;
		}

		const jobGoal = 'Apply for a Backend Development Internship targeting Node.js and Express.';
		let isComplete = false;
		let stallCount = 0;
		const MAX_STALLS = 10;
		/** Agent-side source of truth for filled fields — immune to React state lag. */
		const filledIds = new Set();

		while (!isComplete && stallCount < MAX_STALLS) {
			const simplifiedDOM = await getSimplifiedDOM(page);

			// ── Submit guard ─────────────────────────────────────────────────
			// Only submit when there are ZERO unfilled non-button fields left.
			const remaining = buildPayloadChunk(simplifiedDOM, filledIds);
			if (remaining.length === 0) {
				console.log('[Agent] All fields filled — looking for submit button…');
				const submitBtn = simplifiedDOM.find((el) => {
					const t = (el.type || '').toLowerCase();
					const lbl = (el.label || '').toLowerCase();
					if (!isButtonElement(el) && t !== 'button') return false;
					const SUBMIT_LABELS = ['submit', 'apply', 'next', 'continue', 'send', 'finish'];
					return SUBMIT_LABELS.some((s) => lbl.includes(s));
				});
				if (submitBtn) {
					const submitSel = `[data-ai-id="${submitBtn.ai_id}"]`;
					console.log(`[Agent] Submitting via ${submitBtn.ai_id} ("${submitBtn.label}")`);
					await page.click(submitSel);
					isComplete = true;
					break;
				} else {
					console.warn('[Agent] No recognisable submit button found — stopping.');
					break;
				}
			}

			const nextAction = await determineNextAction(simplifiedDOM, jobGoal, userData);

			if (!nextAction || !nextAction.action || !nextAction.ai_id) {
				stallCount += 1;
				console.warn(
					`[Agent] No valid action (stall ${stallCount}/${MAX_STALLS}). Waiting before retry…`
				);
				await page.waitForTimeout(3000);
				continue;
			}

			stallCount = 0; // reset on successful action
			const { action, ai_id: aiId, value } = nextAction;

			// Guard: reject submit actions returned by the LLM (submit is now handled above)
			if (action === 'submit') {
				console.warn('[Agent] LLM returned submit but form is not complete yet — ignoring.');
				stallCount += 1;
				await page.waitForTimeout(2000);
				continue;
			}

			const targetSelector = `[data-ai-id="${aiId}"]`;
			console.log(`[Agent] Action: ${action} → ${aiId}  value: "${value || ''}"`);

			switch (action) {
				case 'click': {
					try {
						await page.click(targetSelector);
					} catch (clickErr) {
						// Overlay (e.g. iti__flag phone picker) intercepting pointer events → force click
						if (clickErr.message.includes('intercepts pointer events')) {
							console.warn('[Agent] Overlay intercepted click – retrying with force:true');
							await page.click(targetSelector, { force: true });
						} else {
							throw clickErr;
						}
					}
					break;
				}

				case 'type_text': {
					const textVal = String(value || '').trim();

					const isFileInput = await page.evaluate((sel) => {
						const el = document.querySelector(sel);
						if (!el) return false;
						return (
							el.tagName?.toLowerCase() === 'input' &&
							(el.getAttribute('type') || '').toLowerCase() === 'file'
						);
					}, targetSelector);

					if (isFileInput) {
						const resumePath = String(userData?.resumePath || './resume.pdf');
						await page.locator(targetSelector).setInputFiles(resumePath);
						filledIds.add(aiId);
						console.log(
							`[Agent] type_text mapped to file upload for ${aiId}; uploaded ${resumePath} ✔ (tracked)`
						);
						break;
					}

					if (!textVal) {
						console.warn(
							`[Agent] type_text on ${aiId} received empty value – skipping (field needs RAG or userData).`
						);
						stallCount += 1;
						break;
					}
					// Use reactFill so React flushes state — prevents re-filling on next loop
					await reactFill(page, targetSelector, textVal);
					filledIds.add(aiId);
					console.log(`[Agent] Filled ${aiId} ✔ (tracked)`);
					break;
				}

				case 'select_dropdown': {
					const optionText = String(value || '').trim();
					if (!optionText) {
						console.warn('[Agent] select_dropdown received empty value – skipping.');
						stallCount += 1;
						break;
					}

					// ── Tier 0: React Select / combobox – type-to-search ──────────────
					// If the target element is a text input with role="combobox", typing into
					// it triggers the search results; then we pick the first result.
					const isComboInput = await page.evaluate(
						(sel) => {
							const el = document.querySelector(sel);
							return el?.tagName?.toLowerCase() === 'input' && el?.getAttribute('role') === 'combobox';
						},
						targetSelector
					);
					if (isComboInput) {
						try {
							await page.fill(targetSelector, optionText); // triggers dropdown
							await page.waitForTimeout(800); // let results render
							const firstResult = page
								.locator('[role="option"]')
								.filter({ visible: true })
								.first();
							const hasResult = await firstResult.count();
							if (hasResult) {
								await firstResult.click({ timeout: 5000 });
								console.log(`[Agent] React Select (type-to-search): chose first result for "${optionText}"`);
								break;
							}
						} catch (e) {
							console.warn(`[Agent] React Select type-to-search failed: ${e.message}`);
						}
					}

					// ── Tier 1: native <select> ──────────────────────────────────────
					// page.selectOption() is synchronous and never times out on a bad locator.
					const isNativeSelect = await page.evaluate(
						(sel) => document.querySelector(sel)?.tagName?.toLowerCase() === 'select',
						targetSelector
					);
					if (isNativeSelect) {
						try {
							// Try exact label match first, then value attribute as fallback.
							await page.selectOption(targetSelector, { label: optionText });
							console.log(`[Agent] Native select: chose "${optionText}"`);
							break;
						} catch {
							// label didn't match – try partial value match
							try {
								await page.selectOption(targetSelector, optionText);
								console.log(`[Agent] Native select (value): chose "${optionText}"`);
								break;
							} catch (e2) {
								console.warn(`[Agent] Native select failed for "${optionText}": ${e2.message}`);
							}
						}
					}

					// ── Tier 2: custom combobox – open then search inside the listbox ─
					await page.click(targetSelector);

					// Wait up to 3 s for any visible listbox/dropdown container to appear.
					const listboxSel = '[role="listbox"], [role="menu"], ul.select2-results__options, .dropdown-menu';
					const listboxHandle = await page
						.locator(listboxSel)
						.filter({ visible: true })
						.first()
						.elementHandle({ timeout: 3000 })
						.catch(() => null);

					if (listboxHandle) {
						try {
							// Search only *within* the open listbox (scoped → no false matches).
							const optionInBox = page
								.locator(listboxSel)
								.filter({ visible: true })
								.first()
								.locator('[role="option"], li')
								.filter({ hasText: new RegExp(optionText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') })
								.first();
							await optionInBox.click({ timeout: 5000 });
							console.log(`[Agent] Combobox (scoped): chose "${optionText}"`);
							break;
						} catch (e) {
							console.warn(`[Agent] Scoped listbox click failed: ${e.message}`);
						}
					}

					// ── Tier 3: page-wide fuzzy fallback ─────────────────────────────
					// Narrow to only [role="option"] and <option> to avoid matching every <div>/<span>.
					try {
						const fuzzy = page
							.locator('[role="option"], option')
							.filter({ hasText: optionText })
							.first();
						await fuzzy.click({ timeout: 5000 });
						filledIds.add(aiId);
						console.log(`[Agent] Page-wide fallback: chose "${optionText}"`);
					} catch (e) {
						console.warn(
							`[Agent] All select strategies failed for "${optionText}": ${e.message} – skipping field.`
						);
					}
					break;
				}

				case 'upload_file': {
					console.log(`[Agent] Uploading resume to ${aiId}`);
					await page.locator(targetSelector).setInputFiles('./resume.pdf');
					filledIds.add(aiId);
					break;
				}

				case 'submit':
					await page.click(targetSelector);
					isComplete = true;
					break;

				case 'answer_complex_field': {
					const targetEl = simplifiedDOM.find((el) => el.ai_id === aiId);
					const question = String(targetEl?.label || '').trim();
					if (!question) {
						console.warn(`[Agent] Could not resolve label for ai_id: ${aiId} – skipping.`);
						break;
					}

					// ── Try userData.customQuestions first (instant, no Ollama) ──────
					const customAnswers = userData?.customQuestions || {};
					const quickAnswer = Object.entries(customAnswers).find(([key]) =>
						question.toLowerCase().includes(key.toLowerCase())
					)?.[1];

					if (quickAnswer) {
						await reactFill(page, targetSelector, String(quickAnswer));
						filledIds.add(aiId);
						console.log(`[userData] Answered "${question}" → "${quickAnswer}" ✔ (tracked)`);
						break;
					}

					// ── Fallback to RAG pipeline (Ollama) ────────────────────────────
					const answer = await resumeMemory.answerQuestion(question);
					await reactFill(page, targetSelector, answer);
					filledIds.add(aiId);
					console.log(`[RAG] Answered "${question}" → "${answer.slice(0, 80)}…" ✔ (tracked)`);
					break;
				}

				default:
					console.warn(`[Agent] Unknown action "${action}" – stopping loop.`);
					isComplete = true;
			}

			await page.waitForTimeout(2000);
		}

		if (stallCount >= MAX_STALLS) {
			console.warn('[Agent] Max stalls reached – exiting without submission.');
		}
	} catch (error) {
		console.error('[Agent] Fatal error in processJobApplication:', error?.message || error);
	} finally {
		if (browser) await browser.close();
	}
}

module.exports = { determineNextAction, processJobApplication };
