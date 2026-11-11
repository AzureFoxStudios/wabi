/**
 * The upload route answers `pendingReview` and `reviewBranch`. The callers in
 * this app read `pending_review` and `review_branch`. Without both spellings an
 * upload that went to a review branch is shown as an ordinary saved revision.
 */
export interface ReviewFields {
	pending_review?: boolean;
	review_branch?: string;
}

export function withReviewFields<T extends object>(raw: T): T & ReviewFields {
	const source = raw as Record<string, unknown>;
	const pending = source.pending_review ?? source.pendingReview;
	const branch = source.review_branch ?? source.reviewBranch;
	return {
		...raw,
		...(typeof pending === 'boolean' ? { pending_review: pending } : {}),
		...(typeof branch === 'string' ? { review_branch: branch } : {})
	};
}
