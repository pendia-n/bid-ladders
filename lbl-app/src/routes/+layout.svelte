<script lang="ts">
	import '../app.css';

	let { children } = $props();
</script>

<svelte:head>
	<title>HitLam - A Praising On Your Stamina</title>
	<meta name="description" content="HitLam - A Praising On Your Stamina" />
</svelte:head>

{@render children()}
