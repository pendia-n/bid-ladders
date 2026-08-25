<script lang="ts">
	import { onMount } from 'svelte';

	type Role = 'seller' | 'buyer';
	type User = { id: number; username: string; role: Role; totp_enabled: boolean };
	type Listing = {
		id: number; name: string; summary: string; description?: string; product_url: string;
		asking_price: number; mrr: number; mrr_status: string; operating_cost: number;
		assets_included: string; seller_username: string; rank: number; visible_on_home: boolean;
		is_sponsored: boolean; paid_bid: number | null; verified_at?: string;
	};
	type Deal = { id: number; listing_id: number; listing_name: string; offer: number; status: string; buyer_username: string; seller_username: string };
	type Message = { id: number; body: string; username: string; created_at: string };
	type Product = { id: string; name: string; description?: string; prices: { id: string; unit_amount: number; currency: string; recurring?: { interval: string; interval_count: number } }[] };

	let user = $state<User | null>(null);
	let token = $state('');
	let listings = $state<Listing[]>([]);
	let deals = $state<Deal[]>([]);
	let selectedDeal = $state<Deal | null>(null);
	let messages = $state<Message[]>([]);
	let view = $state<'market' | 'mrr' | 'deals'>('market');
	let search = $state('');
	let loading = $state(true);
	let error = $state('');
	let notice = $state('');
	let modal = $state<'auth' | 'buyer' | 'listing' | 'offer' | 'bid' | 'stripe' | null>(null);
	let authMode = $state<'login' | 'signup'>('signup');
	let authRole = $state<Role>('buyer');
	let authUsername = $state('');
	let authPassword = $state('');
	let formName = $state('');
	let formUrl = $state('');
	let formSummary = $state('');
	let formDescription = $state('');
	let formPrice = $state('');
	let formCosts = $state('');
	let formAssets = $state('');
	let formMrrStatus = $state('unknown');
	let formPublish = $state(true);
	let stripeKey = $state('');
	let stripeProducts = $state<Product[]>([]);
	let selectedProduct = $state<Product | null>(null);
	let selectedPrices = $state<string[]>([]);
	let stripeListingId = $state(0);
	let offerListing = $state<Listing | null>(null);
	let offerAmount = $state('');
	let offerMessage = $state('');
	let bidListing = $state<Listing | null>(null);
	let bidAmount = $state('2');
	let bidRank = $state('1');
	let messageDraft = $state('');
	let buyerLegal = $state('');
	let buyerCompany = $state('');
	let buyerTitle = $state('');
	let buyerCountry = $state('');
	let buyerTimezone = $state('Asia/Hong_Kong');
	let buyerBudget = $state('');
	let buyerEntity = $state('personal');

	const money = (value: number) => value === 0 ? '$0' : `$${Math.round(value).toLocaleString()}`;
	const api = async (path: string, init: RequestInit = {}) => {
		const headers = new Headers(init.headers);
		headers.set('content-type', 'application/json');
		if (token) headers.set('authorization', `Bearer ${token}`);
		const response = await fetch(`/api/${path}`, { ...init, headers });
		const data = await response.json().catch(() => ({}));
		if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
		return data;
	};

	async function loadListings() {
		loading = true;
		try {
			const data = await api(`listings${search.trim() ? `?q=${encodeURIComponent(search.trim())}` : ''}`);
			listings = data.listings || [];
			error = '';
		} catch (cause) { error = cause instanceof Error ? cause.message : 'Unable to load listings'; }
		loading = false;
	}

	async function loadDeals() {
		if (!token) return;
		try { deals = (await api('deals')).deals || []; } catch (cause) { error = cause instanceof Error ? cause.message : 'Unable to load deals'; }
	}

	async function restoreSession() {
		const saved = localStorage.getItem('lbl-token');
		if (!saved) return;
		token = saved;
		try { user = (await api('auth/me')).user; await loadDeals(); } catch { localStorage.removeItem('lbl-token'); token = ''; user = null; }
	}

	async function submitAuth() {
		error = '';
		try {
			const endpoint = authMode === 'signup' ? 'auth/signup' : 'auth/login';
			const data = await api(endpoint, { method: 'POST', body: JSON.stringify({ username: authUsername, password: authPassword, role: authRole }) });
			token = data.token; user = data.user; localStorage.setItem('lbl-token', token); modal = null; authPassword = ''; notice = authMode === 'signup' ? 'Account created. Complete the short onboarding step before acting.' : 'Welcome back.'; await loadDeals();
		} catch (cause) { error = cause instanceof Error ? cause.message : 'Unable to authenticate'; }
	}

	function signOut() { token = ''; user = null; localStorage.removeItem('lbl-token'); view = 'market'; selectedDeal = null; }

	async function submitBuyer() {
		try { await api('onboarding/buyer', { method: 'POST', body: JSON.stringify({ legalName: buyerLegal, companyName: buyerCompany, roleTitle: buyerTitle, country: buyerCountry, timezone: buyerTimezone, budgetRange: buyerBudget, purchaseEntity: buyerEntity }) }); modal = null; notice = 'Buyer profile saved. You can now contact sellers.'; } catch (cause) { error = cause instanceof Error ? cause.message : 'Unable to save buyer profile'; }
	}

	async function submitListing() {
		try {
			const data = await api('listings', { method: 'POST', body: JSON.stringify({ productUrl: formUrl, name: formName, summary: formSummary, description: formDescription, askingPrice: formPrice, operatingCost: formCosts, assetsIncluded: formAssets, mrrStatus: formMrrStatus, publish: formPublish }) });
			modal = null; notice = formPublish ? 'Listing published. Verify its Stripe product to add the MRR signal.' : 'Draft saved.'; await loadListings();
			if (stripeKey && data.id) { stripeListingId = data.id; modal = 'stripe'; }
		} catch (cause) { error = cause instanceof Error ? cause.message : 'Unable to save listing'; }
	}

	async function searchStripe() {
		try { stripeProducts = (await api('stripe/search', { method: 'POST', body: JSON.stringify({ stripeKey, name: formName }) })).products || []; selectedProduct = null; selectedPrices = []; } catch (cause) { error = cause instanceof Error ? cause.message : 'Stripe search failed'; }
	}

	async function verifyStripe() {
		if (!selectedProduct || !selectedPrices.length) return;
		try { await api(`listings/${stripeListingId}/verify`, { method: 'POST', body: JSON.stringify({ stripeKey, productId: selectedProduct.id, priceIds: selectedPrices }) }); modal = null; notice = 'Stripe product confirmed and MRR snapshot saved.'; await loadListings(); } catch (cause) { error = cause instanceof Error ? cause.message : 'Stripe verification failed'; }
	}

	async function submitOffer() {
		if (!offerListing) return;
		try { await api('deals/offer', { method: 'POST', body: JSON.stringify({ listingId: offerListing.id, offer: offerAmount, message: offerMessage }) }); modal = null; notice = 'Offer sent. Continue the negotiation in the deal room.'; await loadDeals(); view = 'deals'; } catch (cause) { error = cause instanceof Error ? cause.message : 'Unable to send offer'; }
	}

	async function submitBid() {
		if (!bidListing) return;
		try { const data = await api(`listings/${bidListing.id}/bid`, { method: 'POST', body: JSON.stringify({ amount: bidAmount, desiredRank: bidRank }) }); window.location.href = data.url; } catch (cause) { error = cause instanceof Error ? cause.message : 'Unable to start bid checkout'; }
	}

	async function openDeal(deal: Deal) {
		selectedDeal = deal;
		try { messages = (await api(`deals/${deal.id}/messages`)).messages || []; } catch (cause) { error = cause instanceof Error ? cause.message : 'Unable to load conversation'; }
	}

	async function sendMessage() {
		if (!selectedDeal || !messageDraft.trim()) return;
		try { await api(`deals/${selectedDeal.id}/messages`, { method: 'POST', body: JSON.stringify({ body: messageDraft }) }); messageDraft = ''; await openDeal(selectedDeal); } catch (cause) { error = cause instanceof Error ? cause.message : 'Unable to send message'; }
	}

	onMount(async () => { await restoreSession(); await loadListings(); });
</script>

<svelte:head><title>BidLadders | Product-level acquisition board</title></svelte:head>

<div class="app-shell">
	<header class="topbar">
		<a class="brand" href="/" aria-label="BidLadders home"><span class="brand-mark">BL</span><span>BidLadders</span></a>
		<nav class="nav" aria-label="Primary navigation">
			<button class:active={view === 'market'} onclick={() => { view = 'market'; loadListings(); }}>Market</button>
			<button class:active={view === 'mrr'} onclick={() => { view = 'mrr'; loadListings(); }}>All MRR</button>
			<button class:active={view === 'deals'} onclick={() => { view = 'deals'; loadDeals(); }}>Deal room</button>
		</nav>
		<div class="account-actions">
			{#if user}
				<span class="user-chip">@{user.username} <small>{user.role}</small></span>
				<button class="button ghost" onclick={signOut}>Sign out</button>
			{:else}
				<button class="button ghost" onclick={() => { authMode = 'login'; modal = 'auth'; }}>Sign in</button>
				<button class="button dark" onclick={() => { authMode = 'signup'; modal = 'auth'; }}>Join</button>
			{/if}
		</div>
	</header>

	<main>
		<section class="masthead">
			<div>
				<p class="eyebrow">PRODUCT-LEVEL ACQUISITIONS</p>
				<h1>Small products,<br /><em>visible opportunities.</em></h1>
				<p class="lede">A transparent board for buying and selling one product at a time. Verified signals when available, honest context when they are not.</p>
			</div>
			<div class="masthead-note"><span class="signal-dot"></span><span>Two ladders<br /><strong>330 positions</strong></span></div>
		</section>

		<section class="toolbar">
			<label class="search-wrap"><span>⌕</span><input class="search" bind:value={search} onkeydown={(event) => event.key === 'Enter' && loadListings()} placeholder="Search by product name" aria-label="Search listings" /></label>
			<div class="toolbar-copy"><span class="live-pill">LIVE BOARD</span><span>Paid ranks first, then free listings by arrival.</span></div>
			{#if user?.role === 'seller'}<button class="button coral" onclick={() => { modal = 'listing'; error = ''; }}>+ List a product</button>{:else if user?.role === 'buyer'}<button class="button yellow" onclick={() => modal = 'buyer'}>Complete buyer profile</button>{/if}
		</section>

		{#if notice}<div class="notice">{notice}<button aria-label="Dismiss" onclick={() => notice = ''}>×</button></div>{/if}
		{#if error}<div class="error-banner">{error}<button aria-label="Dismiss" onclick={() => error = ''}>×</button></div>{/if}

		{#if view === 'deals'}
			<section class="workspace-heading"><div><p class="eyebrow">PRIVATE DEAL ROOM</p><h2>Conversations with context.</h2></div><p>Keep offers, diligence questions, and next steps attached to the exact product listing.</p></section>
			{#if !user}<div class="empty-state"><strong>Sign in to see deal rooms.</strong><button class="button dark" onclick={() => { authMode = 'login'; modal = 'auth'; }}>Sign in</button></div>
			{:else}<div class="deal-layout"><div class="deal-list">{#if !deals.length}<div class="empty-state compact"><strong>No deal rooms yet.</strong><span>Buyer offers create the first room.</span></div>{/if}{#each deals as deal}<button class="deal-row" class:selected={selectedDeal?.id === deal.id} onclick={() => openDeal(deal)}><span><strong>{deal.listing_name}</strong><small>{deal.buyer_username} ↔ {deal.seller_username}</small></span><span class="deal-amount">{money(deal.offer)}<small>{deal.status}</small></span></button>{/each}</div><div class="conversation">{#if selectedDeal}<div class="conversation-head"><div><p class="eyebrow">DEAL #{selectedDeal.id}</p><h3>{selectedDeal.listing_name}</h3></div><span class="status-tag">{selectedDeal.status}</span></div><div class="messages">{#each messages as message}<div class:mine={message.username === user.username} class="message"><small>@{message.username} · {new Date(message.created_at).toLocaleString()}</small><p>{message.body}</p></div>{/each}</div><form class="message-box" onsubmit={(event) => { event.preventDefault(); sendMessage(); }}><input bind:value={messageDraft} placeholder="Write a negotiation note..." /><button class="button dark" type="submit">Send</button></form>{:else}<div class="empty-state"><strong>Select a deal room.</strong><span>Offers and replies stay connected to the listing.</span></div>{/if}</div></div>{/if}
		{:else}
			<section class="workspace-heading"><div><p class="eyebrow">{view === 'market' ? 'THE FIRST 330' : 'SEARCHABLE ARCHIVE'}</p><h2>{view === 'market' ? 'The board is the product.' : 'Every listing stays discoverable.'}</h2></div><p>{view === 'market' ? 'A paid rank buys visibility for seven days. Free listings still earn their place by being early.' : 'Use the name filter to find listings beyond the homepage board.'}</p></section>
			{#if loading}<div class="empty-state"><strong>Loading the board...</strong></div>{:else if !listings.length}<div class="empty-state"><strong>No listings match that search.</strong><span>Be the first product on the board.</span>{#if user?.role === 'seller'}<button class="button coral" onclick={() => modal = 'listing'}>List a product</button>{/if}</div>{:else}<div class="ladder-grid"><section class="ladder"><div class="ladder-head"><span class="ladder-label">LADDER A</span><strong>01—165</strong></div>{#each listings.filter((_, index) => (view === 'mrr' || index < 330) && index % 2 === 0) as listing, index}<article class="listing-row" class:sponsored={listing.is_sponsored}><div class="rank">{String(listing.rank).padStart(3, '0')}</div><div class="listing-main"><div class="listing-title"><a href={listing.product_url} target="_blank" rel="noreferrer">{listing.name}</a>{#if listing.is_sponsored}<span class="sponsored-tag">SPONSORED · ${listing.paid_bid}</span>{/if}</div><p>{listing.summary}</p><div class="listing-meta"><span class="mrr-tag {listing.mrr_status}">{listing.mrr_status === 'verified' ? 'VERIFIED MRR' : listing.mrr_status === 'zero' ? '$0 MRR' : 'MRR UNVERIFIED'} · {money(listing.mrr)}</span><span>Ask {money(listing.asking_price)}</span><span>@{listing.seller_username}</span></div></div><div class="row-actions">{#if user?.role === 'buyer'}<button class="icon-button" title="Make an offer" onclick={() => { offerListing = listing; modal = 'offer'; }}>↗</button>{/if}{#if user?.role === 'seller'}<button class="icon-button bid" title="Boost this listing" onclick={() => { bidListing = listing; modal = 'bid'; }}>↑</button>{/if}</div></article>{/each}</section><section class="ladder"><div class="ladder-head"><span class="ladder-label">LADDER B</span><strong>166—330</strong></div>{#each listings.filter((_, index) => (view === 'mrr' || index < 330) && index % 2 === 1) as listing}<article class="listing-row" class:sponsored={listing.is_sponsored}><div class="rank">{String(listing.rank).padStart(3, '0')}</div><div class="listing-main"><div class="listing-title"><a href={listing.product_url} target="_blank" rel="noreferrer">{listing.name}</a>{#if listing.is_sponsored}<span class="sponsored-tag">SPONSORED · ${listing.paid_bid}</span>{/if}</div><p>{listing.summary}</p><div class="listing-meta"><span class="mrr-tag {listing.mrr_status}">{listing.mrr_status === 'verified' ? 'VERIFIED MRR' : listing.mrr_status === 'zero' ? '$0 MRR' : 'MRR UNVERIFIED'} · {money(listing.mrr)}</span><span>Ask {money(listing.asking_price)}</span><span>@{listing.seller_username}</span></div></div><div class="row-actions">{#if user?.role === 'buyer'}<button class="icon-button" title="Make an offer" onclick={() => { offerListing = listing; modal = 'offer'; }}>↗</button>{/if}{#if user?.role === 'seller'}<button class="icon-button bid" title="Boost this listing" onclick={() => { bidListing = listing; modal = 'bid'; }}>↑</button>{/if}</div></article>{/each}</section></div>{/if}
		{/if}
	</main>

	<footer><span>BidLadders · one product per listing</span><span>MRR is a signal, not a promise.</span></footer>
</div>

{#if modal}
	<div class="modal-backdrop" role="presentation" onclick={(event) => event.currentTarget === event.target && (modal = null)}>
		<div class="modal" role="dialog" aria-modal="true">
			<button class="modal-close" aria-label="Close" onclick={() => modal = null}>×</button>
			{#if modal === 'auth'}
				<p class="eyebrow">{authMode === 'signup' ? 'CREATE YOUR ACCOUNT' : 'WELCOME BACK'}</p><h2>{authMode === 'signup' ? 'Join the board.' : 'Sign in.'}</h2><p class="modal-intro">One account can be a seller or a buyer. Use a strong password; optional TOTP protects sensitive account actions.</p>
				<div class="segmented"><button class:chosen={authMode === 'signup'} onclick={() => authMode = 'signup'}>Sign up</button><button class:chosen={authMode === 'login'} onclick={() => authMode = 'login'}>Sign in</button></div>
				<div class="field"><label>Username</label><input bind:value={authUsername} placeholder="lowercase, 3–24 characters" /></div><div class="field"><label>Password</label><input type="password" bind:value={authPassword} placeholder="12+ chars, upper/lower/number" /></div>{#if authMode === 'signup'}<div class="field"><label>I am here to</label><div class="segmented"><button class:chosen={authRole === 'buyer'} onclick={() => authRole = 'buyer'}>Buy a product</button><button class:chosen={authRole === 'seller'} onclick={() => authRole = 'seller'}>Sell a product</button></div></div>{/if}<button class="button dark full" onclick={submitAuth}>{authMode === 'signup' ? 'Create account' : 'Sign in'}</button>
			{:else if modal === 'buyer'}
				<p class="eyebrow">BUYER ONBOARDING</p><h2>Make a credible first move.</h2><p class="modal-intro">Sellers see who is making an offer and what kind of buyer they are dealing with. No payment is taken at this step.</p><div class="form-grid"><div class="field"><label>Legal name</label><input bind:value={buyerLegal} /></div><div class="field"><label>Company name (optional)</label><input bind:value={buyerCompany} /></div><div class="field"><label>Role / title</label><input bind:value={buyerTitle} /></div><div class="field"><label>Country</label><input bind:value={buyerCountry} /></div><div class="field"><label>Timezone</label><input bind:value={buyerTimezone} /></div><div class="field"><label>Budget range</label><input bind:value={buyerBudget} placeholder="$5k–$25k" /></div></div><div class="field"><label>Purchase as</label><div class="segmented"><button class:chosen={buyerEntity === 'personal'} onclick={() => buyerEntity = 'personal'}>Personally</button><button class:chosen={buyerEntity === 'company'} onclick={() => buyerEntity = 'company'}>A company</button></div></div><button class="button dark full" onclick={submitBuyer}>Save buyer profile</button>
			{:else if modal === 'listing'}
				<p class="eyebrow">SELLER ONBOARDING</p><h2>List one product.</h2><p class="modal-intro">Your Stripe key is used only to find the exact product and Price IDs you confirm. The listing is not a sale of your LLC or Stripe account.</p><div class="field"><label>Product URL</label><input bind:value={formUrl} placeholder="https://yourproduct.com" /></div><div class="field"><label>Product name</label><input bind:value={formName} placeholder="Lipstick Digital" /></div><div class="field"><label>One-line summary</label><input bind:value={formSummary} placeholder="What does this product do?" /></div><div class="field"><label>Description {formMrrStatus === 'zero' ? '(required for $0 MRR)' : '(optional)'}</label><textarea bind:value={formDescription} rows="3" placeholder="Customers, distribution, stack, constraints, and what transfers..."></textarea></div><div class="form-grid"><div class="field"><label>Asking price (USD)</label><input type="number" bind:value={formPrice} min="0" /></div><div class="field"><label>Monthly operating cost</label><input type="number" bind:value={formCosts} min="0" /></div></div><div class="field"><label>Assets included</label><input bind:value={formAssets} placeholder="Code, domain, brand, customer list..." /></div><div class="field"><label>MRR status</label><div class="segmented"><button class:chosen={formMrrStatus === 'unknown'} onclick={() => formMrrStatus = 'unknown'}>Unknown</button><button class:chosen={formMrrStatus === 'zero'} onclick={() => formMrrStatus = 'zero'}>$0 MRR</button><button class:chosen={formMrrStatus === 'verified'} onclick={() => formMrrStatus = 'verified'}>Verified</button></div></div><div class="field check-row"><input id="publish" type="checkbox" bind:checked={formPublish} /><label for="publish">Publish immediately</label></div><div class="field"><label>Restricted Stripe key (optional now)</label><input type="password" bind:value={stripeKey} placeholder="rk_test_..." /></div><button class="button coral full" onclick={submitListing}>Save listing</button>
			{:else if modal === 'stripe'}
				<p class="eyebrow">MRR VERIFICATION</p><h2>Confirm the exact Stripe product.</h2><p class="modal-intro">Search uses the product name as a starting point. You must choose the exact Product and Price IDs before any number is shown as verified.</p><div class="field"><label>Restricted read-only key</label><input type="password" bind:value={stripeKey} placeholder="rk_test_..." /></div><button class="button dark full" onclick={searchStripe}>Search Stripe</button>{#if stripeProducts.length}<div class="stripe-results">{#each stripeProducts as product}<button class="product-choice" class:chosen={selectedProduct?.id === product.id} onclick={() => { selectedProduct = product; selectedPrices = []; }}><strong>{product.name}</strong><small>{product.id}</small></button>{/each}</div>{/if}{#if selectedProduct}<div class="price-list"><p class="eyebrow">{selectedProduct.name} PRICES</p>{#each selectedProduct.prices as price}<label class="price-choice"><input type="checkbox" checked={selectedPrices.includes(price.id)} onchange={(event) => selectedPrices = event.currentTarget.checked ? [...selectedPrices, price.id] : selectedPrices.filter((id) => id !== price.id)} /><span>{price.id}<small>{price.currency.toUpperCase()} {((price.unit_amount || 0) / 100).toFixed(2)} · {price.recurring?.interval || 'one-time'}</small></span></label>{/each}</div><button class="button mint full" onclick={verifyStripe}>Verify selected Prices</button>{/if}
			{:else if modal === 'offer' && offerListing}
				<p class="eyebrow">FIRST MOVE</p><h2>Open a conversation about {offerListing.name}.</h2><p class="modal-intro">This creates an offer and a private deal room. Acquisition funds are not held by BidLadders in this MVP.</p><div class="field"><label>Your offer (USD)</label><input type="number" bind:value={offerAmount} min="0" /></div><div class="field"><label>Message to the seller</label><textarea bind:value={offerMessage} rows="5" placeholder="Introduce yourself, explain the fit, and name your proposed next step..."></textarea></div><button class="button yellow full" onclick={submitOffer}>Send offer</button>
			{:else if modal === 'bid' && bidListing}
				<p class="eyebrow">VISIBILITY BID</p><h2>Move {bidListing.name} up.</h2><p class="modal-intro">The bid is for seven days. First paid rank is $2; every later paid position must beat the selected position by at least $0.50. Checkout opens after you submit.</p><div class="form-grid"><div class="field"><label>Desired rank</label><input type="number" bind:value={bidRank} min="1" max="330" /></div><div class="field"><label>Bid (USD)</label><input type="number" bind:value={bidAmount} min="2" step="0.50" /></div></div><button class="button coral full" onclick={submitBid}>Continue to checkout</button>
			{/if}
		</div>
	</div>
{/if}
