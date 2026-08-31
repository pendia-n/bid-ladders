<script lang="ts">
	import { onMount } from 'svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const listing = $derived(data.listing as any);
	const money = (value: number | null | undefined) => value == null ? 'Not provided' : value === 0 ? '$0' : `$${Math.round(value).toLocaleString()}`;
	const percent = (value: number | null | undefined) => value == null ? 'Not provided' : `${value > 0 ? '+' : ''}${Number(value).toFixed(1)}%`;
	const techStack = (value: unknown) => { try { const parsed = JSON.parse(String(value || '')); return Array.isArray(parsed) ? parsed.join(' · ') : String(value || 'Not provided yet.'); } catch { return String(value || 'Not provided yet.'); } };
	const dailyMax = (daily: { cents: number }[] = []) => Math.max(1, ...daily.map((point) => Number(point.cents || 0)));
	let copied = $state(false);
	let githubActivity = $state<any>(null);
	let githubLoading = $state(false);
	let viewer = $state<{ id: number; role: 'seller' | 'buyer' } | null>(null);
	let privateGoogle = $state<{ analytics?: any; searchConsole?: any } | null>(null);

	async function loadViewer() {
		const token = localStorage.getItem('lbl-token');
		if (!token) return;
		const response = await fetch('/api/auth/me', { headers: { authorization: `Bearer ${token}` } });
		if (response.ok) viewer = (await response.json()).user;
		if (viewer?.id === listing?.seller_id) { const google = await fetch(`/api/listings/${encodeURIComponent(listing.id)}/google`, { headers: { authorization: `Bearer ${token}` } }); if (google.ok) privateGoogle = await google.json(); }
	}

	onMount(async () => {
		await loadViewer();
		if (!listing?.github_url) return;
		githubLoading = true;
		try { const response = await fetch(`/api/listings/${encodeURIComponent(listing.id)}/github`); if (response.ok) githubActivity = (await response.json()).activity; } finally { githubLoading = false; }
	});

	async function shareListing() {
		try {
			if (navigator.share) await navigator.share({ title: listing?.name, text: listing?.summary, url: window.location.href });
			else { await navigator.clipboard.writeText(window.location.href); copied = true; setTimeout(() => copied = false, 1800); }
		} catch { /* Sharing can be cancelled by the user. */ }
	}
</script>

<svelte:head>
	<title>{listing ? `${listing.name} | BidLadders` : 'Product not found | BidLadders'}</title>
	<meta name="description" content={listing?.summary || 'Product listing on BidLadders'} />
</svelte:head>

{#if !listing}
	<div class="detail-shell"><a class="back-link" href="/">← Back to BidLadders</a><div class="empty-state detail-empty"><strong>Product listing not found.</strong><a class="button dark" href="/">Return to the board</a></div></div>
{:else}
	<div class="detail-shell">
		<nav class="detail-nav"><a class="brand" href="/"><img class="brand-logo" src="/bid.svg" alt="" /><span>BidLadders</span></a><a class="back-link" href="/">← Board</a></nav>
		<header class="detail-hero">
			<div class="detail-identity"><div class="product-mark">{#if listing.product_icon_url || listing.images?.[0]}<img src={listing.product_icon_url || listing.images?.[0]} alt="" />{:else}<img src="/bid.svg" alt="" />{/if}</div><div><p class="eyebrow">PRODUCT · {listing.category || 'UNCLASSIFIED'}</p><h1>{listing.name}</h1><p class="detail-summary">{listing.summary}</p><p class="seller-line"><img src={listing.seller_profile_image_url || '/profile.svg'} alt="" /> Listed by @{listing.seller_username}</p></div></div>
			<div class="detail-actions"><button class="button ghost" onclick={shareListing} title="Share this product">{copied ? 'Copied' : 'Share'}</button><a class="button dark" href={listing.product_url} target="_blank" rel="noreferrer">Visit product ↗</a></div>
		</header>

		<section class="detail-metrics" aria-label="Verified product metrics">
				<article class="detail-metric"><span>All-time revenue</span><strong>{money(listing.total_revenue)}</strong><small>{listing.total_revenue == null ? 'No readable Stripe revenue attached' : listing.mrr_status === 'verified' ? 'Attributed to the verified Stripe product family' : 'Seller-provided context'}</small></article>
			<article class="detail-metric"><span>MRR</span><strong>{money(listing.mrr)}</strong><small>{listing.mrr_status === 'verified' ? 'Verified from seller-confirmed Stripe prices' : listing.mrr_status === 'zero' ? '$0 MRR stated by seller' : 'Not verified'}</small></article>
			<article class="detail-metric"><span>Asking price</span><strong>{money(listing.asking_price)}</strong><small>Product-level listing, not an LLC sale</small></article>
			<article class="detail-metric"><span>Operating cost</span><strong>{money(listing.operating_cost)}</strong><small>Monthly figure supplied by seller</small></article>
		</section>

		<section class="revenue-panel">
				<div class="panel-heading"><div><p class="eyebrow">REVENUE SIGNAL</p><h2>{money(listing.last_30d_revenue)} <small>{percent(listing.growth_percent)} vs. prior period</small></h2></div><span class="period-chip">Rolling 30 days</span></div>
				{#if listing.last_30d_revenue == null}<div class="chart-empty"><strong>No revenue history attached yet.</strong><span>Connect Stripe and verify the product family to attach a revenue total.</span></div>{:else if listing.last_30d_revenue === 0}<div class="chart-empty"><strong>$0 in paid revenue in the last 30 days.</strong><span>Stripe reported no paid revenue for the verified Price set in this period.</span></div>{:else if listing.revenue_daily?.length}<div class="bar-chart">{#each listing.revenue_daily as point}<span style={`height: ${Math.max(2, Number(point.cents || 0) / dailyMax(listing.revenue_daily) * 100)}%`} title={`${point.date}: ${money(Number(point.cents || 0) / 100)}`}></span>{/each}</div><div class="chart-axis"><span>{listing.revenue_daily[0].date}</span><span>{listing.revenue_daily[listing.revenue_daily.length - 1].date}</span></div>{:else}<div class="chart-empty"><strong>{money(listing.last_30d_revenue)} in the last 30 days.</strong><span>A daily series was unavailable from the connected Stripe data.</span></div>{/if}
		</section>

		<div class="detail-columns">
			<section class="insights-section"><div class="panel-heading"><div><p class="eyebrow">PRODUCT INSIGHTS</p><h2>Context before contact.</h2></div></div><div class="insight-grid"><article><span>Problem solved</span><p>{listing.problem_solved || 'Not provided yet.'}</p></article><article><span>Audience</span><p>{listing.audience || 'Not provided yet.'}</p></article><article><span>Pricing</span><p>{listing.pricing_model || 'Not provided yet.'}</p></article><article><span>Tech stack</span><p>{techStack(listing.tech_stack)}</p></article><article><span>Description</span><p>{listing.description || 'The seller has not added a longer description.'}</p></article><article><span>Assets included</span><p>{listing.assets_included || 'Not provided yet.'}</p></article></div></section>
				<aside class="contact-panel"><p class="eyebrow">INTERESTED?</p><h2>Make the first move.</h2><p>Buyer onboarding and deal-room conversation happen on the board. No anonymous offers.</p><strong class="deal-count">{listing.deal_count || 0} active buyer conversation{listing.deal_count === 1 ? '' : 's'}</strong>{#if !listing.for_sale}<small>This product is published for discovery but is not currently available for sale.</small>{:else if viewer?.role === 'buyer' && viewer.id !== listing.seller_id}<a class="button yellow full" href="/?intent=offer&listing={listing.id}">Open a deal room</a>{:else if viewer?.id === listing.seller_id}<small>You are the creator of this product. Buyer inquiries appear in your Deal room.</small>{:else}<small>Sign in as a buyer to contact the seller.</small>{/if}<small>Offers are negotiated directly. BidLadders does not hold acquisition funds in this MVP.</small></aside>
		</div>

		<section class="connections-section"><div class="panel-heading"><div><p class="eyebrow">PROVIDER SIGNALS</p><h2>Connected where available.</h2></div><span class="panel-note">No Meta · No DataFast · No anonymous mode</span></div><div class="connection-grid"><article class:connected={!!listing.google_analytics_property}><strong>Google Analytics</strong><span>{listing.google_analytics_property || 'Not connected'}</span>{#if listing.google_analytics || privateGoogle?.analytics}<small>{(listing.google_analytics || privateGoogle?.analytics).activeUsers} active users · {(listing.google_analytics || privateGoogle?.analytics).sessions} sessions · {(listing.google_analytics || privateGoogle?.analytics).pageViews} page views</small>{/if}</article><article class:connected={!!listing.google_search_console_url}><strong>Google Search Console</strong><span>{listing.google_search_console_url || 'Not connected'}</span>{#if listing.google_search_console || privateGoogle?.searchConsole}<small>{(listing.google_search_console || privateGoogle?.searchConsole).clicks} clicks · {(listing.google_search_console || privateGoogle?.searchConsole).impressions} impressions · avg position {(listing.google_search_console || privateGoogle?.searchConsole).averagePosition.toFixed(1)}</small>{/if}</article><article class:connected={!!listing.github_url}><strong>GitHub activity</strong>{#if listing.github_url}<a href={listing.github_url} target="_blank" rel="noreferrer">Open repository ↗</a>{:else}<span>Not connected</span>{/if}</article></div></section>
		<section class="github-panel"><div><p class="eyebrow">GITHUB ACTIVITY</p>{#if !listing.github_url}<h2>No repository supplied yet.</h2><p>A public repository link can be added by the seller.</p>{:else if githubLoading}<h2>Loading repository activity...</h2><p>Reading the public repository timeline.</p>{:else if githubActivity}<h2>{githubActivity.repository.name}</h2><p>{githubActivity.repository.description || 'Public repository activity is connected to this product.'}</p><div class="github-stats"><span>{githubActivity.events?.length || 0} recent events</span><span>{githubActivity.repository.stars} stars</span><span>{githubActivity.repository.forks} forks</span>{#if githubActivity.repository.language}<span>{githubActivity.repository.language}</span>{/if}</div>{:else}<h2>Repository activity unavailable.</h2><p>The URL is saved, but GitHub did not return a readable public timeline.</p>{/if}</div>{#if listing.github_url}<a class="button ghost" href={listing.github_url} target="_blank" rel="noreferrer">View GitHub ↗</a>{/if}</section>
		<footer><span>BidLadders · product-level acquisition</span><span>MRR is a signal, not a promise.</span></footer>
	</div>
{/if}
