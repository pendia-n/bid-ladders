<script lang="ts">
	import '../app.css';

	let { children } = $props();
</script>

<svelte:head>
	<title>BidLadders — explore products, find your next opportunity</title>
	<meta name="description" content="Product-level MRR verification and a transparent acquisition ranking for small internet businesses." />
</svelte:head>

{@render children()}
