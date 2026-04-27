const fs = require('fs');
const pdfParse = require('pdf-parse');
const axios = require('axios');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';
const OLLAMA_RAG_MODEL = process.env.OLLAMA_RAG_MODEL || 'llama3.2';

class ResumeMemory {
	constructor() {
		this.vectorStore = [];
	}

	/**
	 * Ingest a resume PDF, chunk text, embed each chunk, and cache vectors in memory.
	 * @param {string} filePath
	 * @returns {Promise<number>}
	 */
	async loadResume(filePath) {
		try {
			const fileBuffer = await fs.promises.readFile(filePath);
			const parsed = await pdfParse(fileBuffer);
			const resumeText = (parsed?.text || '').trim();

			return this.loadResumeFromText(resumeText);
		} catch (error) {
			const errorDetails = error?.response?.data || error?.message || error;
			console.error('Failed to load resume into memory:', errorDetails);
			throw error;
		}
	}

	/**
	 * Ingest resume text directly, chunk it, and cache vectors in memory.
	 * @param {string} resumeText
	 * @returns {Promise<number>}
	 */
	async loadResumeFromText(resumeText) {
		const normalizedText = String(resumeText || '').trim();

		if (!normalizedText) {
			throw new Error('No resume text provided.');
		}

		const chunks = this._chunkText(normalizedText);
		if (!chunks.length) {
			throw new Error('No chunkable resume text found.');
		}

		this.vectorStore = [];

		for (const chunk of chunks) {
			const embeddingResponse = await axios.post(
				`${OLLAMA_URL}/api/embeddings`,
				{
					model: OLLAMA_EMBED_MODEL,
					prompt: chunk
				},
				{
					timeout: 120000
				}
			);

			const vector = embeddingResponse?.data?.embedding;
			if (!Array.isArray(vector)) {
				throw new Error('Invalid embedding response while ingesting resume chunks.');
			}

			this.vectorStore.push({
				text: chunk,
				vector
			});
		}

		return this.vectorStore.length;
	}

	/**
	 * Answer ATS-style questions using top semantic resume chunks.
	 * @param {string} question
	 * @returns {Promise<string>}
	 */
	async answerQuestion(question) {
		if (!question || typeof question !== 'string') {
			throw new Error('answerQuestion requires a non-empty question string.');
		}

		if (!this.vectorStore.length) {
			throw new Error('Resume memory is empty. Call loadResume(filePath) or loadResumeFromText(text) first.');
		}

		try {
			const questionEmbeddingResponse = await axios.post(
				`${OLLAMA_URL}/api/embeddings`,
				{
					model: OLLAMA_EMBED_MODEL,
					prompt: question
				},
				{
					timeout: 120000
				}
			);

			const questionVector = questionEmbeddingResponse?.data?.embedding;
			if (!Array.isArray(questionVector)) {
				throw new Error('Invalid embedding response while vectorizing question.');
			}

			const ranked = this.vectorStore
				.map((entry) => ({
					...entry,
					score: this.#cosineSimilarity(questionVector, entry.vector)
				}))
				.sort((a, b) => b.score - a.score);

			const topChunks = ranked.slice(0, 2).map((item) => item.text);

			const prompt = [
				'You are a professional applicant.',
				`Answer the following ATS question: ${question}.`,
				'Use ONLY the following facts from my resume to answer:',
				topChunks.map((chunk, index) => `Chunk ${index + 1}: ${chunk}`).join('\n\n'),
				'Keep the answer under 3 sentences.'
			].join('\n\n');

			const generationResponse = await axios.post(
				`${OLLAMA_URL}/api/generate`,
				{
					model: OLLAMA_RAG_MODEL,
					stream: false,
					prompt
				},
				{
					timeout: 120000
				}
			);

			return String(generationResponse?.data?.response || '').trim();
		} catch (error) {
			const errorDetails = error?.response?.data || error?.message || error;
			console.error('Failed to answer ATS question from resume memory:', errorDetails);
			throw error;
		}
	}

	_chunkText(text) {
		const paragraphChunks = text
			.split(/\n\s*\n/g)
			.map((segment) => segment.replace(/\s+/g, ' ').trim())
			.filter(Boolean);

		const chunks = [];
		for (const paragraph of paragraphChunks) {
			const words = paragraph.split(/\s+/).filter(Boolean);

			if (words.length <= 300) {
				chunks.push(paragraph);
				continue;
			}

			for (let index = 0; index < words.length; index += 300) {
				chunks.push(words.slice(index, index + 300).join(' '));
			}
		}

		return chunks;
	}

	#cosineSimilarity(a, b) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) {
			return -1;
		}

		let dot = 0;
		let magnitudeA = 0;
		let magnitudeB = 0;

		for (let i = 0; i < a.length; i += 1) {
			const aVal = Number(a[i]);
			const bVal = Number(b[i]);

			if (Number.isNaN(aVal) || Number.isNaN(bVal)) {
				return -1;
			}

			dot += aVal * bVal;
			magnitudeA += aVal * aVal;
			magnitudeB += bVal * bVal;
		}

		const denominator = Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB);
		if (!denominator) {
			return -1;
		}

		return dot / denominator;
	}
}

module.exports = {
	ResumeMemory
};
