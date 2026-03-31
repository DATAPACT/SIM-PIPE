import { GraphQLClient } from 'graphql-request';
import * as config from '../lib/config';
import { graphQLClient, username, usertoken } from '../stores/stores';

const TOOLBOX_ORIGIN: string = config.TOOLBOX_ORIGIN ?? '*';

function isOriginTrusted(origin: string): boolean {
	if (TOOLBOX_ORIGIN === '*') return true;
	return origin === TOOLBOX_ORIGIN;
}

function applyToken(graphqlUrl: string, token: string): void {
	let usernameFromToken = '';
	try {
		// JWTs use base64url encoding — replace url-safe chars before decoding.
		const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
		const payload = JSON.parse(atob(base64)) as Record<string, unknown>;
		usernameFromToken =
			typeof payload.preferred_username === 'string'
				? payload.preferred_username
				: typeof payload.sub === 'string'
					? payload.sub
					: '';
	} catch {
		// token may not be a standard JWT — username stays empty
	}
	usertoken.set(token);
	username.set(usernameFromToken);
	graphQLClient.set(
		new GraphQLClient(graphqlUrl, {
			headers: { authorization: `Bearer ${token}` }
		})
	);
}

function waitForSSOToken(): Promise<string> {
	return new Promise((resolve, reject) => {
		let attempts = 0;
		const state: { interval: ReturnType<typeof setInterval> | undefined } = {
			interval: undefined
		};

		const cleanup = () => {
			if (state.interval !== undefined) clearInterval(state.interval);
			window.removeEventListener('message', handleMessage);
		};

		const handleMessage = (event: MessageEvent) => {
			if (!isOriginTrusted(event.origin)) return;
			const { type, token } = (event.data ?? {}) as { type?: string; token?: string };
			if (type === 'SSO_TOKEN' && typeof token === 'string') {
				cleanup();
				resolve(token);
			}
		};

		window.addEventListener('message', handleMessage);

		const sendReady = () => {
			window.parent.postMessage(
				{ type: 'IFRAME_READY' },
				TOOLBOX_ORIGIN === '*' ? '*' : TOOLBOX_ORIGIN
			);
		};

		sendReady();

		state.interval = setInterval(() => {
			if (attempts++ >= 10) {
				cleanup();
				reject(
					new Error(
						'SIM-PIPE did not receive an SSO token from the parent window within 20 seconds. ' +
							'Ensure the parent is configured to send an SSO_TOKEN postMessage and that ' +
							`NEXT_PUBLIC_ALLOWED_IFRAME_ORIGINS includes "${window.location.origin}".`
					)
				);
				return;
			}
			sendReady();
		}, 2000);
	});
}

export async function initIframeAuth(graphqlUrl: string): Promise<void> {
	if (!config.TOOLBOX_ORIGIN) {
		console.error(
			'[iframeAuth] VITE_TOOLBOX_ORIGIN is not set — accepting postMessage tokens from ANY origin. ' +
				'Set VITE_TOOLBOX_ORIGIN to the parent window origin in production.'
		);
	}

	console.log('[iframeAuth] Running inside iframe, waiting for SSO token from parent...');
	const token = await waitForSSOToken();
	console.log('[iframeAuth] SSO token received');

	applyToken(graphqlUrl, token);

	// Keep listening for token refreshes sent by the parent (e.g. after expiry).
	window.addEventListener('message', (event: MessageEvent) => {
		if (!isOriginTrusted(event.origin)) return;
		const { type, token: refreshedToken } = (event.data ?? {}) as {
			type?: string;
			token?: string;
		};
		if (type === 'SSO_TOKEN' && typeof refreshedToken === 'string') {
			console.log('[iframeAuth] SSO token refreshed');
			applyToken(graphqlUrl, refreshedToken);
		}
	});
}