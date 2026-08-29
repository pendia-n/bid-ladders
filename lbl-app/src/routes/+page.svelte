<script lang="ts">
	import { onMount } from 'svelte';

	type Role = 'seller' | 'buyer';
	type User = { id: number; username: string; role: Role; totp_enabled: boolean; profile_image_key?: string | null; display_name?: string | null; bio?: string | null; website?: string | null; country?: string | null; timezone?: string | null };
	type Listing = {
		id: number; seller_id: number; name: string; summary: string; description?: string; product_url: string;
		asking_price: number; mrr: number; mrr_status: string; operating_cost: number;
		assets_included: string; seller_username: string; rank: number; visible_on_home: boolean;
		is_sponsored: boolean; paid_bid: number | null; verified_at?: string; seller_profile_image_url?: string; product_icon_url?: string | null; images?: string[];
		category?: string | null; problem_solved?: string | null; audience?: string | null; pricing_model?: string | null; tech_stack?: string | null;
		total_revenue?: number | null; last_30d_revenue?: number | null; active_customers?: number | null; growth_percent?: number | null; churn_percent?: number | null;
		deal_count?: number; revenue_daily?: { date: string; cents: number }[] | null; github_url?: string | null; google_analytics_property?: string | null; google_search_console_url?: string | null; google_analytics?: any; google_search_console?: any;
	};
	type Deal = { id: number; listing_id: number; listing_name: string; offer: number; status: string; buyer_id: number; seller_id: number; buyer_username: string; seller_username: string; escrow_provider?: string | null; escrow_transaction_id?: string | null; escrow_status?: string | null; escrow_url?: string | null };
	type Message = { id: number; body: string; username: string; created_at: string; media?: { url: string; mime_type: string; byte_size: number }[] };
	type CarouselSlot = { id: number; status: 'available' | 'reserved' | 'paid'; listing?: { listing_id: number; name: string; product_url: string; summary: string; image_url?: string } | null; expiresAt?: number };
	type StripeFamily = { id: string; name: string; productIds: string[]; productNames: string[]; prices: { id: string; active?: boolean; unit_amount: number; currency: string; recurring?: { interval: string; interval_count: number } }[] };
	const stripeCreateUrl = 'https://dashboard.stripe.com/apikeys/create?name=BidLadders&permissions%5B%5D=rak_charge_read&permissions%5B%5D=rak_subscription_read&permissions%5B%5D=rak_plan_read&permissions%5B%5D=rak_bucket_connect_read&permissions%5B%5D=rak_file_read&permissions%5B%5D=rak_product_read';
	const categories = ['AI', 'Developer Tools', 'Productivity', 'Marketing', 'Media', 'E-commerce', 'Education', 'Finance', 'Health', 'Social', 'Consumer', 'Other'];
	const pricingModels = ['Subscription', 'One-time', 'Usage-based', 'Freemium', 'Advertising', 'Marketplace', 'Other'];
	const techOptions = ['HTML', 'CSS', 'JavaScript', 'TypeScript', 'Svelte', 'React', 'Vue', 'Node.js', 'Ruby', 'Python', 'Go', 'SQL', 'PostgreSQL', 'SQLite', 'MongoDB', 'Prisma', 'Cloudflare', 'AWS', 'Stripe'];

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
	let modal = $state<'auth' | 'buyer' | 'listing' | 'offer' | 'bid' | 'stripe' | 'carousel' | null>(null);
	let authMode = $state<'login' | 'signup'>('signup');
	let authRole = $state<Role>('buyer');
	let authUsername = $state('');
	let authPassword = $state('');
	let profileFile = $state<File | null>(null);
	let productIconFile = $state<File | null>(null);
	let formName = $state('');
	let formUrl = $state('');
	let formSummary = $state('');
	let formDescription = $state('');
	let formPrice = $state('');
	let formCosts = $state('');
	let formAssets = $state('');
	let formMrrStatus = $state('unknown');
	let formPublish = $state(true);
	let listingFiles = $state<File[]>([]);
	let formCategory = $state('');
	let formCategoryOther = $state('');
	let formProblem = $state('');
	let formAudience = $state('');
	let formPricing = $state('');
	let selectedTech = $state<string[]>([]);
	let formTechOther = $state('');
	let formTotalRevenue = $state('');
	let formLast30dRevenue = $state('');
	let formActiveCustomers = $state('');
	let formGrowth = $state('');
	let formChurn = $state('');
	let formGithubUrl = $state('');
	let formGoogleAnalytics = $state('');
	let formSearchConsole = $state('');
	let connectGoogleAnalytics = $state(false);
	let connectSearchConsole = $state(false);
	let connectGithub = $state(false);
	let formPublicMetrics = $state(false);
	let stripeKey = $state('');
	let stripeFamilies = $state<StripeFamily[]>([]);
	let selectedFamily = $state<StripeFamily | null>(null);
	let stripeSearched = $state(false);
	let stripeListingId = $state(0);
	let editingListing = $state<Listing | null>(null);
	let offerListing = $state<Listing | null>(null);
	let offerAmount = $state('');
	let offerMessage = $state('');
	let bidListing = $state<Listing | null>(null);
	let bidAmount = $state('2');
	let bidRank = $state('1');
	let messageDraft = $state('');
	let messageFile = $state<File | null>(null);
	let buyerLegal = $state('');
	let buyerCompany = $state('');
	let buyerTitle = $state('');
	let buyerCountry = $state('');
	let buyerTimezone = $state('Asia/Hong_Kong');
	let buyerBudget = $state('');
	let buyerEntity = $state('personal');
	let carouselSlots = $state<CarouselSlot[]>([]);
	let carouselListingId = $state('');
	let carouselSlotId = $state(0);

	const money = (value: number) => value === 0 ? '$0' : `$${Math.round(value).toLocaleString()}`;
	const optionalMoney = (value?: number | null) => value == null ? 'Not provided' : money(value);
	const avatarUrl = (key?: string | null) => key ? `/api/media?key=${encodeURIComponent(key)}` : '/profile.svg';
	const api = async (path: string, init: RequestInit = {}) => {
		const headers = new Headers(init.headers);
		if (!(init.body instanceof FormData)) headers.set('content-type', 'application/json');
		if (token) headers.set('authorization', `Bearer ${token}`);
		const response = await fetch(`/api/${path}`, { ...init, headers });
		const data = await response.json().catch(() => ({}));
		if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
		return data;
	};

	function chooseProfile(event: Event) {
		const file = (event.currentTarget as HTMLInputElement).files?.[0] || null;
		if (file && file.size > 2 * 1024 * 1024) { error = 'Profile picture must be 2MB or smaller'; profileFile = null; return; }
		profileFile = file;
	}

	function chooseListingImages(event: Event) {
		const files = Array.from((event.currentTarget as HTMLInputElement).files || []);
		if (files.some((file) => file.size > 2 * 1024 * 1024 || !['image/jpeg', 'image/png'].includes(file.type))) { error = 'Each listing image must be PNG or JPG and 2MB or smaller'; listingFiles = []; return; }
		listingFiles = files.slice(0, 5);
		if (files.length > 5) notice = 'Only the first five listing images were selected.';
	}

	function chooseProductIcon(event: Event) {
		const file = (event.currentTarget as HTMLInputElement).files?.[0] || null;
		if (file && (file.size > 1024 * 1024 || !['image/jpeg', 'image/png'].includes(file.type))) { error = 'Product icon must be PNG or JPG and 1MB or smaller'; productIconFile = null; return; }
		productIconFile = file;
	}

	function toggleTech(value: string) { selectedTech = selectedTech.includes(value) ? selectedTech.filter((item) => item !== value) : [...selectedTech, value]; }

	function resetListingForm() {
		editingListing = null; formName = ''; formUrl = ''; formSummary = ''; formDescription = ''; formPrice = ''; formCosts = ''; formAssets = ''; formMrrStatus = 'unknown'; formPublish = true; listingFiles = []; productIconFile = null; formCategory = ''; formCategoryOther = ''; formProblem = ''; formAudience = ''; formPricing = ''; selectedTech = []; formTechOther = ''; formTotalRevenue = ''; formLast30dRevenue = ''; formActiveCustomers = ''; formGrowth = ''; formChurn = ''; formGithubUrl = ''; formGoogleAnalytics = ''; formSearchConsole = ''; connectGoogleAnalytics = false; connectSearchConsole = false; connectGithub = false; formPublicMetrics = false; stripeKey = '';
	}

	function openNewListing() { resetListingForm(); modal = 'listing'; error = ''; }

	function openEditListing(listing: Listing) {
		editingListing = listing; formName = listing.name; formUrl = listing.product_url; formSummary = listing.summary; formDescription = listing.description || ''; formPrice = String(listing.asking_price ?? ''); formCosts = String(listing.operating_cost ?? ''); formAssets = listing.assets_included || ''; formMrrStatus = listing.mrr_status || 'unknown'; formPublish = true; formCategory = listing.category && categories.includes(listing.category) ? listing.category : listing.category ? 'Other' : ''; formCategoryOther = listing.category && !categories.includes(listing.category) ? listing.category : ''; formProblem = listing.problem_solved || ''; formAudience = listing.audience || ''; formPricing = listing.pricing_model || ''; formTotalRevenue = listing.total_revenue == null ? '' : String(listing.total_revenue); formLast30dRevenue = listing.last_30d_revenue == null ? '' : String(listing.last_30d_revenue); formActiveCustomers = listing.active_customers == null ? '' : String(listing.active_customers); formGrowth = listing.growth_percent == null ? '' : String(listing.growth_percent); formChurn = listing.churn_percent == null ? '' : String(listing.churn_percent); formGithubUrl = listing.github_url || ''; formGoogleAnalytics = listing.google_analytics_property || ''; formSearchConsole = listing.google_search_console_url || ''; connectGoogleAnalytics = !!formGoogleAnalytics; connectSearchConsole = !!formSearchConsole; connectGithub = !!formGithubUrl; formPublicMetrics = !!(listing as any).public_metrics; formTechOther = ''; selectedTech = [];
		try { const parsed = JSON.parse(String(listing.tech_stack || '')); selectedTech = Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string' && techOptions.includes(value)) : []; const other = Array.isArray(parsed) ? parsed.find((value) => typeof value === 'string' && !techOptions.includes(value)) : ''; formTechOther = other || ''; } catch { selectedTech = String(listing.tech_stack || '').split(',').map((value) => value.trim()).filter((value) => techOptions.includes(value)); }
		modal = 'listing'; error = '';
	}

	async function deleteListing(listing: Listing) {
		if (!window.confirm(`Remove ${listing.name} from the public board?`)) return;
		try { await api(`listings/${listing.id}`, { method: 'DELETE' }); notice = 'Listing removed from the public board.'; await loadListings(); } catch (cause) { error = cause instanceof Error ? cause.message : 'Unable to remove listing'; }
	}

	function openStripeForListing(listing: Listing) { stripeListingId = listing.id; formName = listing.name; stripeKey = ''; stripeFamilies = []; selectedFamily = null; stripeSearched = false; modal = 'stripe'; error = ''; }

	async function loadListings() {
		loading = true;
		try {
			const data = await api(`listings${search.trim() ? `?q=${encodeURIComponent(search.trim())}` : ''}`);
			listings = data.listings || [];
			error = '';
		} catch (cause) { error = cause instanceof Error ? cause.message : 'Unable to load listings'; }
		loading = false;
	}

	async function loadCarousel() {
		try { carouselSlots = (await api('carousel')).slots || []; } catch { carouselSlots = Array.from({ length: 12 }, (_, index) => ({ id: index + 1, status: 'available' as const })); }
	}

	function openCarouselSlot(slot: CarouselSlot) {
		if (slot.status === 'paid' && slot.listing?.listing_id) { window.location.href = `/product/${slot.listing.listing_id}`; return; }
		if (slot.status !== 'available') return;
		if (!user) { authMode = 'login'; modal = 'auth'; notice = 'Sign in as a seller to buy a product spot.'; return; }
		if (user.role !== 'seller') { error = 'Only sellers can buy a product spot.'; return; }
		carouselSlotId = slot.id; carouselListingId = ''; modal = 'carousel'; error = '';
	}

	async function buyCarouselSpot() {
		if (!user) { authMode = 'login'; modal = 'auth'; notice = 'Sign in as a seller to buy a product spot.'; return; }
		if (user.role !== 'seller') { error = 'Only sellers can buy a product spot.'; return; }
		if (!carouselListingId || !carouselSlotId) { error = 'Choose a product and an available spot first.'; return; }
		try { const data = await api(`carousel/slots/${carouselSlotId}/reserve`, { method: 'POST', body: JSON.stringify({ listingId: Number(carouselListingId) }) }); window.location.href = data.url; } catch (cause) { error = cause instanceof Error ? cause.message : 'Unable to reserve product spot'; await loadCarousel(); }
	}

	async function loadDeals() {
		if (!token) return;
		try { deals = (await api('deals')).deals || []; } catch (cause) { error = cause instanceof Error ? cause.message : 'Unable to load deals'; }
	}

	async function acceptDeal() {
		if (!selectedDeal) return;
		try { await api(`deals/${selectedDeal.id}/accept`, { method: 'POST' }); notice = 'Deal accepted. Both parties can now start third-party escrow.'; await loadDeals(); selectedDeal = deals.find((deal) => deal.id === selectedDeal?.id) || selectedDeal; } catch (cause) { error = cause instanceof Error ? cause.message : 'Unable to accept deal'; }
	}

	async function startEscrow() {
		if (!selectedDeal) return;
		try { const data = await api(`deals/${selectedDeal.id}/escrow`, { method: 'POST' }); notice = data.escrow?.transactionId ? `Escrow transaction ${data.escrow.transactionId} created. Continue in Escrow.com.` : 'Escrow transaction created.'; await loadDeals(); selectedDeal = deals.find((deal) => deal.id === selectedDeal?.id) || selectedDeal; } catch (cause) { error = cause instanceof Error ? cause.message : 'Unable to start escrow'; }
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
			token = data.token; user = data.user; localStorage.setItem('lbl-token', token);
			if (authMode === 'signup' && profileFile) {
				const form = new FormData(); form.append('image', profileFile);
				await api('media/profile', { method: 'POST', body: form });
				user = (await api('auth/me')).user;
			}
			modal = authMode === 'login' && offerListing && data.user.role === 'buyer' ? 'offer' : null; authPassword = ''; profileFile = null; notice = authMode === 'signup' ? 'Account created. Complete the short onboarding step before acting.' : 'Welcome back.'; await loadDeals();
		} catch (cause) { error = cause instanceof Error ? cause.message : 'Unable to authenticate'; }
	}

	function signOut() { token = ''; user = null; deals = []; messages = []; localStorage.removeItem('lbl-token'); view = 'market'; selectedDeal = null; }

	async function submitBuyer() {
		try { await api('onboarding/buyer', { method: 'POST', body: JSON.stringify({ legalName: buyerLegal, companyName: buyerCompany, roleTitle: buyerTitle, country: buyerCountry, timezone: buyerTimezone, budgetRange: buyerBudget, purchaseEntity: buyerEntity }) }); modal = null; notice = 'Buyer profile saved. You can now contact sellers.'; } catch (cause) { error = cause instanceof Error ? cause.message : 'Unable to save buyer profile'; }
	}

	async function submitListing() {
		try {
			const techStack = JSON.stringify([...selectedTech, ...(formTechOther.trim() ? [formTechOther.trim()] : [])]);
			const category = formCategory === 'Other' ? formCategoryOther.trim() : formCategory;
			const payload = JSON.stringify({ productUrl: formUrl, name: formName, summary: formSummary, description: formDescription, askingPrice: formPrice, operatingCost: formCosts, assetsIncluded: formAssets, mrrStatus: formMrrStatus, publish: formPublish, category, problemSolved: formProblem, audience: formAudience, pricingModel: formPricing, techStack, totalRevenue: formTotalRevenue, last30dRevenue: formLast30dRevenue, activeCustomers: formActiveCustomers, growthPercent: formGrowth, churnPercent: formChurn, githubUrl: formGithubUrl, googleAnalyticsProperty: connectGoogleAnalytics ? formGoogleAnalytics : '', googleSearchConsoleUrl: connectSearchConsole ? formSearchConsole : '', publicMetrics: formPublicMetrics });
			const data = await api(editingListing ? `listings/${editingListing.id}` : 'listings', { method: editingListing ? 'PATCH' : 'POST', body: payload });
			const listingId = Number(data.id || editingListing?.id || 0);
			if (productIconFile && listingId) { const iconForm = new FormData(); iconForm.append('icon', productIconFile); await api(`listings/${listingId}/icon`, { method: 'POST', body: iconForm }); }
			if (listingFiles.length && listingId) {
				const form = new FormData();
				for (const file of listingFiles) form.append('images', file);
				await api(`listings/${listingId}/images`, { method: 'POST', body: form });
			}
			const shouldVerify = !!stripeKey && !!listingId; const name = formName; const wasEditing = !!editingListing; listingFiles = []; productIconFile = null; modal = null; notice = wasEditing ? 'Listing updated.' : formPublish ? 'Listing published. Verify its Stripe product family to add the MRR signal.' : 'Draft saved.'; await loadListings();
			if (shouldVerify) { stripeListingId = listingId; formName = name; stripeFamilies = []; selectedFamily = null; stripeSearched = false; modal = 'stripe'; }
			else resetListingForm();
		} catch (cause) { error = cause instanceof Error ? cause.message : 'Unable to save listing'; }
	}

	async function searchStripe() {
		try { stripeSearched = false; stripeFamilies = (await api('stripe/search', { method: 'POST', body: JSON.stringify({ stripeKey, name: formName }) })).families || []; selectedFamily = stripeFamilies[0] || null; stripeSearched = true; } catch (cause) { error = cause instanceof Error ? cause.message : 'Stripe search failed'; }
	}

	async function verifyStripe() {
		if (!selectedFamily) return;
		try { const data = await api(`listings/${stripeListingId}/verify`, { method: 'POST', body: JSON.stringify({ stripeKey }) }); modal = null; notice = `Stripe family verified across ${data.productCount} Products and all ${data.priceCount} Prices.`; await loadListings(); resetListingForm(); } catch (cause) { error = cause instanceof Error ? cause.message : 'Stripe verification failed'; }
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

	function chooseMessageFile(event: Event) {
		const file = (event.currentTarget as HTMLInputElement).files?.[0] || null;
		if (file && file.size > 1024 * 1024) { error = 'Message media must be 1MB or smaller'; messageFile = null; return; }
		messageFile = file;
	}

	async function sendMessageMedia() {
		if (!selectedDeal || !messageFile) return;
		try { const form = new FormData(); form.append('media', messageFile); if (messageDraft.trim()) form.append('body', messageDraft); await api(`deals/${selectedDeal.id}/messages/media`, { method: 'POST', body: form }); messageDraft = ''; messageFile = null; await openDeal(selectedDeal); } catch (cause) { error = cause instanceof Error ? cause.message : 'Unable to send media'; }
	}

	async function cancelDeal() {
		if (!selectedDeal || !user || user.id !== selectedDeal.buyer_id) return;
		try { await api(`deals/${selectedDeal.id}/cancel`, { method: 'POST' }); selectedDeal = null; messages = []; notice = 'Deal room closed for you. The message history remains stored.'; await loadDeals(); } catch (cause) { error = cause instanceof Error ? cause.message : 'Unable to close deal room'; }
	}

	async function handleIntent() {
		const params = new URLSearchParams(window.location.search);
		if (params.get('intent') !== 'offer') return;
		const listingId = Number(params.get('listing'));
		const target = listings.find((listing) => listing.id === listingId);
		if (!target) return;
		offerListing = target;
		if (user?.role === 'buyer' && user.id !== target.seller_id) modal = 'offer';
		else if (user?.id === target.seller_id) { notice = 'You cannot open a buyer deal room for your own product.'; }
		else { authMode = 'login'; modal = 'auth'; notice = 'Sign in as a buyer to open a deal room for this product.'; }
		window.history.replaceState({}, '', `/`);
	}

	onMount(async () => { await restoreSession(); await Promise.all([loadListings(), loadCarousel()]); await handleIntent(); });
</script>

<svelte:head><title>BidLadders | Product-level acquisition board</title></svelte:head>

<div class="app-shell">
	<header class="topbar">
		<a class="brand" href="/" aria-label="BidLadders home"><img class="brand-logo" src="/bid.svg" alt="" /><span>BidLadders</span></a>
		<nav class="nav" aria-label="Primary navigation">
			<button class:active={view === 'market'} onclick={() => { view = 'market'; loadListings(); }}>Market</button>
			<button class:active={view === 'mrr'} onclick={() => { view = 'mrr'; loadListings(); }}>All MRR</button>
			{#if user}<button class:active={view === 'deals'} onclick={() => { view = 'deals'; loadDeals(); }}>Deal room</button>{/if}
		</nav>
		<div class="account-actions">
			{#if user}
				<span class="user-chip"><img class="user-avatar" src={avatarUrl(user.profile_image_key)} alt="" />@{user.username} <small>{user.role}</small></span>
				<a class="button ghost" href="/profile">Profile</a>
				<button class="button ghost" onclick={signOut}>Sign out</button>
			{:else}
				<button class="button ghost" onclick={() => { authMode = 'login'; modal = 'auth'; }}>Sign in</button>
				<button class="button dark" onclick={() => { authMode = 'signup'; modal = 'auth'; }}>Join</button>
			{/if}
		</div>
	</header>

	<main>
		<section class="carousel-band" aria-label="24-hour product spots">
			<div class="carousel-label"><span class="eyebrow">24-HOUR PRODUCT SPOTS</span><strong>$10</strong><small>Choose a listed product. One spot, one day.</small></div>
			<div class="carousel-track">{#each [...carouselSlots, ...carouselSlots] as slot, index}<button class:occupied={slot.status === 'paid'} class="carousel-slot" title={slot.status === 'paid' ? `${slot.listing?.name || 'Product'} is live` : 'Buy this 24-hour spot'} onclick={() => openCarouselSlot(slot)}><span class="carousel-slot-index">{String((slot.id - 1) % 12 + 1).padStart(2, '0')}</span>{#if slot.status === 'paid' && slot.listing}{#if slot.listing.image_url}<img class="carousel-image" src={slot.listing.image_url} alt="" />{/if}<strong>{slot.listing.name}</strong><small>OPEN LISTING</small>{:else}<span class="carousel-empty">+</span>{/if}</button>{/each}</div>
		</section>
		<section class="masthead">
			<div>
				<p class="eyebrow">PRODUCT-LEVEL ACQUISITIONS</p>
				<h1>Explore products.<br /><em>Find your next opportunity.</em></h1>
				<p class="lede">A transparent board for buying and selling one product at a time. Verified signals when available, honest context when they are not.</p>
			</div>
			<div class="masthead-note"><span class="signal-dot"></span><span>Two ladders<br /><strong>330 positions</strong></span></div>
		</section>

		<section class="toolbar">
			<label class="search-wrap"><span>⌕</span><input class="search" bind:value={search} onkeydown={(event) => event.key === 'Enter' && loadListings()} placeholder="Search by product name" aria-label="Search listings" /></label>
			<div class="toolbar-copy"><span class="live-pill">LIVE BOARD</span><span>Paid ranks first, then free listings by arrival.</span></div>
			{#if user?.role === 'seller'}<button class="button coral" onclick={openNewListing}>+ List a product</button>{:else if user?.role === 'buyer'}<button class="button yellow" onclick={() => modal = 'buyer'}>Complete buyer profile</button>{/if}
		</section>

		{#if notice}<div class="notice">{notice}<button aria-label="Dismiss" onclick={() => notice = ''}>×</button></div>{/if}
		{#if error}<div class="error-banner">{error}<button aria-label="Dismiss" onclick={() => error = ''}>×</button></div>{/if}

		{#if view === 'deals'}
			<section class="workspace-heading"><div><p class="eyebrow">PRIVATE DEAL ROOM</p><h2>Conversations with context.</h2></div><p>Keep offers, diligence questions, and next steps attached to the exact product listing.</p></section>
			{#if !user}<div class="empty-state"><strong>Sign in to see deal rooms.</strong><button class="button dark" onclick={() => { authMode = 'login'; modal = 'auth'; }}>Sign in</button></div>
			{:else}<div class="deal-layout"><div class="deal-list">{#if !deals.length}<div class="empty-state compact"><strong>No deal rooms yet.</strong><span>Buyer offers create the first room.</span></div>{/if}{#each deals as deal}<button class="deal-row" class:selected={selectedDeal?.id === deal.id} onclick={() => openDeal(deal)}><span><strong>{deal.listing_name}</strong><small>{deal.buyer_username} ↔ {deal.seller_username}</small></span><span class="deal-amount">{money(deal.offer)}<small>{deal.status}</small></span></button>{/each}</div><div class="conversation">{#if selectedDeal}<div class="conversation-head"><div><p class="eyebrow">DEAL #{selectedDeal.id}</p><h3>{selectedDeal.listing_name}</h3></div><span class="status-tag">{selectedDeal.status}</span></div><div class="deal-actions">{#if user.id === selectedDeal.seller_id && ["inquiry", "negotiating"].includes(selectedDeal.status)}<button class="button dark" onclick={acceptDeal}>Accept deal</button>{/if}{#if user.id === selectedDeal.buyer_id && selectedDeal.status !== "cancelled"}<button class="button ghost" onclick={cancelDeal}>Close my room</button>{/if}{#if selectedDeal.status === "accepted" && !selectedDeal.escrow_transaction_id}<button class="button yellow" onclick={startEscrow}>Start escrow</button>{/if}{#if selectedDeal.escrow_url}<a class="button ghost" href={selectedDeal.escrow_url} target="_blank" rel="noreferrer">Continue in Escrow.com ↗</a>{/if}</div>{#if selectedDeal.status !== "cancelled"}<div class="messages">{#each messages as message}<div class:mine={message.username === user.username} class="message"><small>@{message.username} · {new Date(message.created_at).toLocaleString()}</small><p>{message.body}</p>{#each message.media || [] as attachment}<a class="message-media" href={attachment.url} target="_blank" rel="noreferrer">{attachment.mime_type.startsWith('image/') ? 'View image' : 'Open attachment'}</a>{/each}</div>{/each}</div><form class="message-box" onsubmit={(event) => { event.preventDefault(); messageFile ? sendMessageMedia() : sendMessage(); }}><input bind:value={messageDraft} placeholder="Write a negotiation note..." /><label class="button ghost upload-button" for="message-media">Attach</label><input id="message-media" class="visually-hidden" type="file" accept="image/*,video/*,audio/*,application/pdf" onchange={chooseMessageFile} />{#if messageFile}<small class="file-note">{messageFile.name}</small>{/if}<button class="button dark" type="submit">Send</button></form>{:else}<div class="empty-state compact"><strong>This buyer room is closed.</strong><span>Message history remains preserved.</span></div>{/if}{:else}<div class="empty-state"><strong>Select a deal room.</strong><span>Offers and replies stay connected to the listing.</span></div>{/if}</div></div>{/if}
		{:else}
				<section class="workspace-heading"><div><p class="eyebrow">{view === 'market' ? 'THE FIRST 330' : 'SEARCHABLE ARCHIVE'}</p><h2>{view === 'market' ? 'The board is the product.' : 'Every listing stays discoverable.'}</h2></div><p>{view === 'market' ? 'Paid ranks stay until another buyer outbids them. Free listings still earn their place by being early.' : 'Use the name filter to find listings beyond the homepage board.'}</p></section>
			{#if loading}
				<div class="empty-state"><strong>Loading the board...</strong></div>
			{:else if !listings.length}
				<div class="empty-state"><strong>No listings match that search.</strong><span>Be the first product on the board.</span>{#if user?.role === 'seller'}<button class="button coral" onclick={openNewListing}>List a product</button>{/if}</div>
			{:else}
				<div class="ladder-grid">
					<section class="ladder">
						<div class="ladder-head"><span class="ladder-label">LADDER A</span><strong>01—165</strong></div>
						{#each listings.filter((_, index) => (view === 'mrr' || index < 330) && index % 2 === 0) as listing}
							<article class="listing-row" class:sponsored={listing.is_sponsored}>
								<div class="rank">{String(listing.rank).padStart(3, '0')}</div>
								<div class="listing-main">
									{#if listing.product_icon_url || listing.images?.[0]}<img class="listing-thumb" src={listing.product_icon_url || listing.images?.[0]} alt="" />{/if}
									<div class="listing-title"><img class="seller-avatar" src={listing.seller_profile_image_url || '/profile.svg'} alt="" /><a href={`/product/${listing.id}`}>{listing.name}</a>{#if listing.is_sponsored}<span class="sponsored-tag">SPONSORED · ${listing.paid_bid}</span>{/if}</div>
									<p>{listing.summary}</p>
									<div class="listing-meta"><span class="mrr-tag {listing.mrr_status}">{listing.mrr_status === 'verified' ? 'VERIFIED MRR' : listing.mrr_status === 'zero' ? '$0 MRR' : 'MRR UNVERIFIED'} · {money(listing.mrr)}</span><span>Ask {money(listing.asking_price)}</span><span>@{listing.seller_username}</span></div>
								</div>
								<div class="row-actions">
									<a class="icon-button" href={`/product/${listing.id}`} title="Open listing details" aria-label="Open listing details">→</a>
									{#if user?.role === 'buyer' && listing.seller_id !== user.id}<button class="icon-button" title="Make an offer" aria-label="Make an offer" onclick={() => { offerListing = listing; modal = 'offer'; }}>↗</button>{/if}
									{#if user?.role === 'seller' && listing.seller_id === user.id}<button class="icon-button bid" title="Boost this listing" aria-label="Boost this listing" onclick={() => { bidListing = listing; modal = 'bid'; }}>↑</button><button class="icon-button" title="Edit listing" aria-label="Edit listing" onclick={() => openEditListing(listing)}>✎</button><button class="icon-button" title="Verify all Stripe Prices" aria-label="Verify all Stripe Prices" onclick={() => openStripeForListing(listing)}>✓</button><button class="icon-button danger" title="Remove listing" aria-label="Remove listing" onclick={() => deleteListing(listing)}>×</button>{/if}
								</div>
							</article>
						{/each}
					</section>
					<section class="ladder">
						<div class="ladder-head"><span class="ladder-label">LADDER B</span><strong>166—330</strong></div>
						{#each listings.filter((_, index) => (view === 'mrr' || index < 330) && index % 2 === 1) as listing}
							<article class="listing-row" class:sponsored={listing.is_sponsored}>
								<div class="rank">{String(listing.rank).padStart(3, '0')}</div>
								<div class="listing-main">
									{#if listing.product_icon_url || listing.images?.[0]}<img class="listing-thumb" src={listing.product_icon_url || listing.images?.[0]} alt="" />{/if}
									<div class="listing-title"><img class="seller-avatar" src={listing.seller_profile_image_url || '/profile.svg'} alt="" /><a href={`/product/${listing.id}`}>{listing.name}</a>{#if listing.is_sponsored}<span class="sponsored-tag">SPONSORED · ${listing.paid_bid}</span>{/if}</div>
									<p>{listing.summary}</p>
									<div class="listing-meta"><span class="mrr-tag {listing.mrr_status}">{listing.mrr_status === 'verified' ? 'VERIFIED MRR' : listing.mrr_status === 'zero' ? '$0 MRR' : 'MRR UNVERIFIED'} · {money(listing.mrr)}</span><span>Ask {money(listing.asking_price)}</span><span>@{listing.seller_username}</span></div>
								</div>
								<div class="row-actions">
									<a class="icon-button" href={`/product/${listing.id}`} title="Open listing details" aria-label="Open listing details">→</a>
									{#if user?.role === 'buyer' && listing.seller_id !== user.id}<button class="icon-button" title="Make an offer" aria-label="Make an offer" onclick={() => { offerListing = listing; modal = 'offer'; }}>↗</button>{/if}
									{#if user?.role === 'seller' && listing.seller_id === user.id}<button class="icon-button bid" title="Boost this listing" aria-label="Boost this listing" onclick={() => { bidListing = listing; modal = 'bid'; }}>↑</button><button class="icon-button" title="Edit listing" aria-label="Edit listing" onclick={() => openEditListing(listing)}>✎</button><button class="icon-button" title="Verify all Stripe Prices" aria-label="Verify all Stripe Prices" onclick={() => openStripeForListing(listing)}>✓</button><button class="icon-button danger" title="Remove listing" aria-label="Remove listing" onclick={() => deleteListing(listing)}>×</button>{/if}
								</div>
							</article>
						{/each}
					</section>
				</div>
			{/if}
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
				<div class="field"><label for="auth-username">Username</label><input id="auth-username" bind:value={authUsername} placeholder="lowercase, 3–24 characters" /></div><div class="field"><label for="auth-password">Password</label><input id="auth-password" type="password" bind:value={authPassword} placeholder="12+ chars, upper/lower/number" /></div>{#if authMode === 'signup'}<div class="field"><label for="auth-profile">Profile picture (optional, max 2MB)</label><input id="auth-profile" type="file" accept="image/jpeg,image/png,image/webp,image/gif" onchange={chooseProfile} /></div><div class="field"><span class="field-label">I am here to</span><div class="segmented"><button class:chosen={authRole === 'buyer'} onclick={() => authRole = 'buyer'}>Buy a product</button><button class:chosen={authRole === 'seller'} onclick={() => authRole = 'seller'}>Sell a product</button></div></div>{/if}<button class="button dark full" onclick={submitAuth}>{authMode === 'signup' ? 'Create account' : 'Sign in'}</button>
			{:else if modal === 'buyer'}
				<p class="eyebrow">BUYER ONBOARDING</p><h2>Make a credible first move.</h2><p class="modal-intro">Sellers see who is making an offer and what kind of buyer they are dealing with. No payment is taken at this step.</p><div class="form-grid"><div class="field"><label for="buyer-legal">Legal name</label><input id="buyer-legal" bind:value={buyerLegal} /></div><div class="field"><label for="buyer-company">Company name (optional)</label><input id="buyer-company" bind:value={buyerCompany} /></div><div class="field"><label for="buyer-title">Role / title</label><input id="buyer-title" bind:value={buyerTitle} /></div><div class="field"><label for="buyer-country">Country</label><input id="buyer-country" bind:value={buyerCountry} /></div><div class="field"><label for="buyer-timezone">Timezone</label><input id="buyer-timezone" bind:value={buyerTimezone} /></div><div class="field"><label for="buyer-budget">Budget range</label><input id="buyer-budget" bind:value={buyerBudget} placeholder="$5k–$25k" /></div></div><div class="field"><span class="field-label">Purchase as</span><div class="segmented"><button class:chosen={buyerEntity === 'personal'} onclick={() => buyerEntity = 'personal'}>Personally</button><button class:chosen={buyerEntity === 'company'} onclick={() => buyerEntity = 'company'}>A company</button></div></div><button class="button dark full" onclick={submitBuyer}>Save buyer profile</button>
			{:else if modal === 'listing'}
				<p class="eyebrow">{editingListing ? 'EDIT PRODUCT LISTING' : 'SELLER ONBOARDING'}</p>
				<h2>{editingListing ? `Edit ${editingListing.name}.` : 'List one product.'}</h2>
				<p class="modal-intro">This is a product listing, not an LLC sale. Verified signals are shown only when the seller supplies or confirms them.</p>
				<div class="field"><label for="form-url">Product URL</label><input id="form-url" bind:value={formUrl} placeholder="https://yourproduct.com" /></div>
				<div class="field"><label for="form-name">Product name</label><input id="form-name" bind:value={formName} placeholder="Lipstick Digital" /></div>
				<div class="field"><label for="form-summary">One-line summary</label><textarea id="form-summary" bind:value={formSummary} rows="3" placeholder="What does this product do?"></textarea></div>
				<div class="form-grid"><div class="field"><label for="form-category">Category</label><select id="form-category" bind:value={formCategory}><option value="">Choose a category</option>{#each categories as category}<option value={category}>{category}</option>{/each}</select>{#if formCategory === 'Other'}<input bind:value={formCategoryOther} placeholder="Custom category" aria-label="Custom category" />{/if}</div><div class="field"><label for="form-audience">Audience</label><textarea id="form-audience" bind:value={formAudience} rows="3" placeholder="Who uses this product and why?"></textarea></div><div class="field"><label for="form-pricing">Pricing model</label><select id="form-pricing" bind:value={formPricing}><option value="">Choose a pricing model</option>{#each pricingModels as pricing}<option value={pricing}>{pricing}</option>{/each}</select></div><div class="field"><span class="field-label">Tech stack</span><div class="tech-picker">{#each techOptions as tech}<button type="button" class:chosen={selectedTech.includes(tech)} onclick={() => toggleTech(tech)}>{tech}</button>{/each}</div><input id="form-tech-other" bind:value={formTechOther} placeholder="Other technology" aria-label="Other technology" /></div></div>
				<div class="field"><label for="form-problem">Problem solved</label><textarea id="form-problem" bind:value={formProblem} rows="2" placeholder="What painful job does this product solve?"></textarea></div>
				<div class="field"><label for="form-description">Description {formMrrStatus === 'zero' ? '(required for $0 MRR)' : '(optional)'}</label><textarea id="form-description" bind:value={formDescription} rows="4" placeholder="Customers, distribution, stack, constraints, and what transfers..."></textarea></div>
				<div class="field"><label for="form-assets">Assets included</label><textarea id="form-assets" bind:value={formAssets} rows="4" placeholder="Code, domain, design files, documentation, customer list, social accounts, or other transfer items."></textarea></div>
				<div class="field"><label for="form-mrr-status">MRR status</label><select id="form-mrr-status" bind:value={formMrrStatus}><option value="unknown">Not verified</option><option value="zero">$0 MRR</option><option value="verified">Verified after Stripe confirmation</option></select></div>
				<div class="form-grid"><div class="field"><label for="form-price">Asking price (USD)</label><input id="form-price" type="number" bind:value={formPrice} min="0" /></div><div class="field"><label for="form-costs">Monthly operating cost</label><input id="form-costs" type="number" bind:value={formCosts} min="0" /></div></div>
				<div class="field"><span class="field-label">Revenue context (optional)</span><div class="form-grid"><input type="number" bind:value={formTotalRevenue} min="0" placeholder="All-time revenue" aria-label="All-time revenue" /><input type="number" bind:value={formLast30dRevenue} min="0" placeholder="Last 30 days revenue" aria-label="Last 30 days revenue" /><input type="number" bind:value={formActiveCustomers} min="0" placeholder="Active customers" aria-label="Active customers" /><input type="number" bind:value={formGrowth} placeholder="Growth % (30d)" aria-label="Growth percent over 30 days" /></div></div>
				<div class="provider-grid"><div class="provider-card"><label class="check-row"><input type="checkbox" bind:checked={connectGoogleAnalytics} /><strong>Google Analytics</strong></label><small>Optional GA4 property ID</small>{#if connectGoogleAnalytics}<input bind:value={formGoogleAnalytics} placeholder="123456789" aria-label="Google Analytics property ID" />{:else}<small class="provider-off">Not connected · skipped</small>{/if}</div><div class="provider-card"><label class="check-row"><input type="checkbox" bind:checked={connectSearchConsole} /><strong>Google Search Console</strong></label><small>Optional property URL</small>{#if connectSearchConsole}<input bind:value={formSearchConsole} placeholder="https://yourproduct.com" aria-label="Google Search Console property URL" />{:else}<small class="provider-off">Not connected · skipped</small>{/if}</div><div class="provider-card"><label class="check-row"><input type="checkbox" bind:checked={connectGithub} /><strong>GitHub activity</strong></label><small>Optional public repository</small>{#if connectGithub}<input bind:value={formGithubUrl} placeholder="https://github.com/org/repo" aria-label="GitHub repository URL" />{:else}<small class="provider-off">Not connected · skipped</small>{/if}</div></div>
				<div class="field check-row"><input id="public-metrics" type="checkbox" bind:checked={formPublicMetrics} /><label for="public-metrics">Publish connected traffic/search summary on the public listing</label></div>
				<div class="field stripe-key-row"><label for="stripe-key">Restricted Stripe key (optional)</label><div class="input-action"><input id="stripe-key" type="password" bind:value={stripeKey} placeholder="rk_test_..." /><a class="icon-button" href={stripeCreateUrl} target="_blank" rel="noreferrer" title="Open the prefilled Stripe restricted-key form in a new tab" aria-label="Open the prefilled Stripe restricted-key form in a new tab">↗</a></div><small class="field-help">Enter it once to save it securely. The same key can verify every product in this Stripe account; leave this blank on later listings to reuse it.</small></div>
				<div class="media-upload-grid"><div class="field"><label for="product-icon">Product icon (optional, PNG/JPG, max 1MB)</label><input id="product-icon" type="file" accept="image/jpeg,image/png" onchange={chooseProductIcon} />{#if productIconFile}<small class="file-note">Icon selected: {productIconFile.name}</small>{/if}</div><div class="field"><label for="listing-images">Product images (optional, PNG/JPG, 0–5; max 2MB each)</label><input id="listing-images" type="file" multiple accept="image/jpeg,image/png" onchange={chooseListingImages} />{#if listingFiles.length}<small class="file-note">{listingFiles.length} image{listingFiles.length === 1 ? '' : 's'} selected</small>{/if}</div></div>
				<div class="field check-row"><input id="publish" type="checkbox" bind:checked={formPublish} /><label for="publish">Publish immediately</label></div>
				{#if editingListing && connectGoogleAnalytics && formGoogleAnalytics}<a class="button ghost full" href={`/api/google/connect?listingId=${editingListing.id}&provider=analytics&property=${encodeURIComponent(formGoogleAnalytics)}`}>Connect Google Analytics</a>{/if}
				{#if editingListing && connectSearchConsole && formSearchConsole}<a class="button ghost full" href={`/api/google/connect?listingId=${editingListing.id}&provider=search_console&property=${encodeURIComponent(formSearchConsole)}`}>Connect Search Console</a>{/if}
				<button class="button coral full" onclick={submitListing}>{editingListing ? 'Save changes' : 'Save listing'}</button>
			{:else if modal === 'stripe'}
				<p class="eyebrow">PRODUCT-FAMILY MRR VERIFICATION</p><h2>Verify the whole product family.</h2><p class="modal-intro">Search using the listing name. BidLadders groups every matching Stripe Product and automatically monitors every Price under them, including one-time and recurring Prices. There is no individual Product or Price selection.</p><div class="field"><label for="stripe-key-modal">Restricted read-only key (optional after first use)</label><input id="stripe-key-modal" type="password" bind:value={stripeKey} placeholder="rk_test_... or leave blank to reuse" /></div><button class="button dark full" onclick={searchStripe}>Find all matching Stripe Products</button>{#if selectedFamily}<div class="price-list stripe-family"><p class="eyebrow">{selectedFamily.name}</p><strong>{selectedFamily.productIds.length} Stripe Products · all {selectedFamily.prices.length} Prices will be monitored</strong><small>{selectedFamily.productNames.join(' · ')}</small><small>Recurring subscriptions and one-time revenue are included where Stripe exposes product attribution.</small></div><button class="button mint full" onclick={verifyStripe}>Verify this entire product family</button>{:else if stripeSearched}<p class="field-help">No matching Stripe Product family was found for &quot;{formName}&quot;. Check the listing name and Stripe Product names or descriptions.</p>{/if}
			{:else if modal === 'carousel'}
				<p class="eyebrow">24-HOUR PRODUCT SPOT</p><h2>Put one product in the moving strip.</h2><p class="modal-intro">$10 buys the selected carousel position for exactly 24 hours. Your product must already be published. The spot is reserved before checkout.</p><div class="field"><label for="carousel-product">Product to display</label><select id="carousel-product" bind:value={carouselListingId}><option value="">Choose a published product</option>{#each listings.filter((listing) => listing.seller_id === user?.id) as listing}<option value={listing.id}>{listing.name}</option>{/each}</select></div><button class="button coral full" onclick={buyCarouselSpot}>Continue to secure checkout · $10</button>
			{:else if modal === 'offer' && offerListing}
				<p class="eyebrow">FIRST MOVE</p><h2>Open a conversation about {offerListing.name}.</h2><p class="modal-intro">This creates an offer and a private deal room. Acquisition funds are not held by BidLadders in this MVP.</p><div class="field"><label for="offer-amount">Your offer (USD)</label><input id="offer-amount" type="number" bind:value={offerAmount} min="0" /></div><div class="field"><label for="offer-message">Message to the seller</label><textarea id="offer-message" bind:value={offerMessage} rows="5" placeholder="Introduce yourself, explain the fit, and name your proposed next step..."></textarea></div><button class="button yellow full" onclick={submitOffer}>Send offer</button>
			{:else if modal === 'bid' && bidListing}
				<p class="eyebrow">VISIBILITY BID</p><h2>Move {bidListing.name} up.</h2><p class="modal-intro">A successful bid keeps this product ranked until another paid bid replaces it. First paid rank is $2; every later target position must beat its current price by at least $0.50. Checkout opens after you submit.</p><div class="form-grid"><div class="field"><label for="bid-rank">Target rank</label><input id="bid-rank" type="number" bind:value={bidRank} min="1" max="330" /></div><div class="field"><label for="bid-amount">Bid (USD)</label><input id="bid-amount" type="number" bind:value={bidAmount} min="2" step="0.50" /></div></div><button class="button coral full" onclick={submitBid}>Continue to checkout</button>
			{/if}
		</div>
	</div>
{/if}
