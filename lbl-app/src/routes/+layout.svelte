<script lang="ts">
	import '../app.css';

	let { children } = $props();
</script>

<svelte:head>
	<title>BidLadders — small products, visible opportunities</title>
	<meta name="description" content="Product-level MRR verification and a transparent acquisition ranking for small internet businesses." />
</svelte:head>

{@render children()}
