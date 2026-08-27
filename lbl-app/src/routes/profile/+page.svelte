<script lang="ts">
	import { onMount } from 'svelte';

	type Profile = { username: string; role: 'seller' | 'buyer'; profile_image_key?: string | null; display_name?: string | null; bio?: string | null; website?: string | null; country?: string | null; timezone?: string | null; contact_email?: string | null; buyer?: { legal_name: string; company_name?: string | null; role_title: string; country: string; timezone: string; budget_range: string; purchase_entity: 'personal' | 'company' } | null };
	let token = $state('');
	let profile = $state<Profile | null>(null);
	let loading = $state(true);
	let saving = $state(false);
	let error = $state('');
	let notice = $state('');
	let imageFile = $state<File | null>(null);
	let displayName = $state('');
	let bio = $state('');
	let website = $state('');
	let country = $state('');
	let timezone = $state('Asia/Hong_Kong');
	let contactEmail = $state('');
	let legalName = $state('');
	let companyName = $state('');
	let roleTitle = $state('');
	let buyerBudget = $state('');
	let purchaseEntity = $state<'personal' | 'company'>('personal');

	const api = async (path: string, init: RequestInit = {}) => {
		const headers = new Headers(init.headers); headers.set('content-type', 'application/json'); headers.set('authorization', `Bearer ${token}`);
		const response = await fetch(`/api/${path}`, { ...init, headers }); const data = await response.json().catch(() => ({}));
		if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`); return data;
	};
	const avatarUrl = (key?: string | null) => key ? `/api/media?key=${encodeURIComponent(key)}` : '/profile.svg';

	function applyProfile(value: Profile) {
		profile = value; displayName = value.display_name || ''; bio = value.bio || ''; website = value.website || ''; country = value.country || ''; timezone = value.timezone || value.buyer?.timezone || 'Asia/Hong_Kong'; contactEmail = value.contact_email || '';
		if (value.buyer) { legalName = value.buyer.legal_name; companyName = value.buyer.company_name || ''; roleTitle = value.buyer.role_title; buyerBudget = value.buyer.budget_range; purchaseEntity = value.buyer.purchase_entity; }
	}

	onMount(async () => {
		token = localStorage.getItem('lbl-token') || '';
		if (!token) { loading = false; return; }
		try { applyProfile((await api('profile')).profile); } catch (cause) { error = cause instanceof Error ? cause.message : 'Unable to load profile'; }
		loading = false;
	});

	async function saveProfile() {
		saving = true; error = '';
		try {
			await api('profile', { method: 'PATCH', body: JSON.stringify({ displayName, bio, website, country, timezone, contactEmail, buyer: { legalName, companyName, roleTitle, country, timezone, budgetRange: buyerBudget, purchaseEntity } }) });
			if (imageFile) { const form = new FormData(); form.append('image', imageFile); const response = await fetch('/api/media/profile', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form }); if (!response.ok) throw new Error('Profile image upload failed'); }
			notice = 'Profile updated.'; applyProfile((await api('profile')).profile); imageFile = null;
		} catch (cause) { error = cause instanceof Error ? cause.message : 'Unable to save profile'; } finally { saving = false; }
	}
</script>

<svelte:head><title>Edit profile | BidLadders</title></svelte:head>

<div class="profile-shell">
	<nav class="detail-nav"><a class="brand" href="/"><img class="brand-logo" src="/bid.svg" alt="" /><span>BidLadders</span></a><a class="back-link" href="/">← Board</a></nav>
	{#if loading}<div class="empty-state"><strong>Loading profile...</strong></div>{:else if !token}<div class="empty-state profile-empty"><strong>Sign in to edit your profile.</strong><a class="button dark" href="/">Return to BidLadders</a></div>{:else if profile}
		<main class="profile-main"><header class="profile-heading"><div><p class="eyebrow">ACCOUNT PROFILE</p><h1>Edit your profile.</h1><p>Keep the person behind the product or purchase inquiry current.</p></div><span class="profile-role">{profile.role}</span></header>
			<section class="profile-card"><div class="profile-avatar-large"><img src={avatarUrl(profile.profile_image_key)} alt="" /></div><div class="profile-identity"><strong>@{profile.username}</strong><small>Username and role cannot be changed here.</small><label class="button ghost upload-button" for="profile-image">Change profile image</label><input id="profile-image" class="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp,image/gif" onchange={(event) => imageFile = (event.currentTarget as HTMLInputElement).files?.[0] || null} /></div></section>
			<div class="profile-form"><div class="field"><label for="display-name">Display name</label><input id="display-name" bind:value={displayName} placeholder="Your name or public identity" /></div><div class="field"><label for="contact-email">Escrow contact email</label><input id="contact-email" type="email" bind:value={contactEmail} placeholder="Used only when starting escrow" /></div><div class="field"><label for="website">Website</label><input id="website" bind:value={website} placeholder="https://" /></div><div class="form-grid"><div class="field"><label for="country">Country</label><input id="country" bind:value={country} /></div><div class="field"><label for="timezone">Timezone</label><input id="timezone" bind:value={timezone} /></div></div><div class="field"><label for="bio">Bio</label><textarea id="bio" bind:value={bio} rows="6" placeholder="A short description of you and what you build or buy."></textarea></div>
				{#if profile.role === 'buyer'}<div class="profile-section"><p class="eyebrow">BUYER DETAILS</p><div class="field"><label for="legal-name">Legal name</label><input id="legal-name" bind:value={legalName} /></div><div class="form-grid"><div class="field"><label for="company-name">Company name</label><input id="company-name" bind:value={companyName} /></div><div class="field"><label for="role-title">Role / title</label><input id="role-title" bind:value={roleTitle} /></div></div><div class="form-grid"><div class="field"><label for="budget">Budget range</label><input id="budget" bind:value={buyerBudget} placeholder="$5k–$25k" /></div><div class="field"><label for="purchase-entity">Purchase as</label><select id="purchase-entity" bind:value={purchaseEntity}><option value="personal">Personally</option><option value="company">A company</option></select></div></div></div>{/if}
				{#if notice}<div class="notice">{notice}</div>{/if}{#if error}<div class="error-banner">{error}</div>{/if}<button class="button dark" onclick={saveProfile} disabled={saving}>{saving ? 'Saving...' : 'Save profile'}</button>
			</div>
		</main>
	{:else}<div class="error-banner">{error || 'Unable to load profile.'}</div>{/if}
</div>
