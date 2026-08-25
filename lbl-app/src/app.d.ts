// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type { D1Database } from '@cloudflare/workers-types';
import type { R2Bucket } from '@cloudflare/workers-types';
import type { DurableObjectNamespace } from '@cloudflare/workers-types';

declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
		interface Platform {
			env?: {
				DB?: D1Database;
			MEDIA?: R2Bucket;
			CAROUSEL_SLOTS?: DurableObjectNamespace;
				JWT_SECRET?: string;
				ENCRYPTION_KEY?: string;
				STRIPE_SECRET_KEY?: string;
				STRIPE_WEBHOOK_SECRET?: string;
				APP_URL?: string;
			};
		}
	}
}

export {};
