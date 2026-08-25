import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params }) => {
	const response = await fetch(`/api/listings/${encodeURIComponent(params.id)}`);
	if (!response.ok) return { listing: null, status: response.status };
	const data = await response.json() as { listing: Record<string, unknown> };
	return { listing: data.listing, status: 200 };
};
