import { describe, expect, test } from 'bun:test';
import { withReviewFields } from './loreUploadResult';

describe('withReviewFields', () => {
	test('reads the spelling the upload route sends', () => {
		const result = withReviewFields({ etag: 'abc', pendingReview: true, reviewBranch: 'uploads/u9-1-abcd' });
		expect(result.pending_review).toBe(true);
		expect(result.review_branch).toBe('uploads/u9-1-abcd');
		expect(result.etag).toBe('abc');
	});

	test('a direct commit is not reported as waiting for review', () => {
		const result = withReviewFields({ etag: 'abc', pendingReview: false, reviewBranch: null });
		expect(result.pending_review).toBe(false);
		expect(result.review_branch).toBeUndefined();
	});

	test('keeps the snake_case spelling when that is what arrived', () => {
		const result = withReviewFields({ pending_review: true, review_branch: 'uploads/x' });
		expect(result.pending_review).toBe(true);
		expect(result.review_branch).toBe('uploads/x');
	});

	test('adds nothing when the answer has neither', () => {
		expect(withReviewFields({ etag: 'abc' })).toEqual({ etag: 'abc' });
	});
});
