import { GraphQLClient } from 'graphql-request';
import Keycloak from 'keycloak-js';
import * as config from '../lib/config';
import { graphQLClient, username, usertoken } from '../stores/stores';
import { browser } from '$app/environment';
import { initIframeAuth } from './iframeAuth';

let initKeycloakPromise: Promise<void> | undefined;

function parseSimPipeEnvironment(): {
	keycloakEnabled: boolean;
	graphqlUrl: string;
} {
	let graphqlUrl = config.SIM_PIPE_CONTROLLER_URL;
	let keycloakEnabled = config.KEYCLOAK_ENABLED;

	if (keycloakEnabled === undefined || graphqlUrl === undefined) {
		const localhostMatch = window.location.host.match(/^(localhost|127\.0\.0\.\d+|::1)(:\d+)?$/);

		if (localhostMatch) {
			keycloakEnabled = keycloakEnabled === undefined ? 'false' : keycloakEnabled;
			if (graphqlUrl === undefined) {
				graphqlUrl = 'http://localhost:8087/graphql';
				console.log('Using default graphqlUrl', graphqlUrl);
			}
		} else {
			keycloakEnabled = keycloakEnabled === undefined ? 'true' : keycloakEnabled;
			graphqlUrl = '/graphql';
		}
	}

	return {
		keycloakEnabled: keycloakEnabled === 'true',
		graphqlUrl
	};
}

async function internalInitKeycloak(graphqlUrl: string): Promise<void> {
	const { sessionStorage } = window;

	const existingToken = sessionStorage.getItem('keycloak-token');
	if (existingToken) {
		const existingExp = sessionStorage.getItem('keycloak-exp');
		if (existingExp) {
			const exp = Number.parseInt(existingExp, 10);
			// If expire in less than 10 minutes, ignore it
			if (exp - Date.now() / 1000 > 10 * 60) {
				usertoken.set(existingToken);
				username.set(sessionStorage.getItem('keycloak-username') ?? '');
				graphQLClient.set(
					new GraphQLClient(graphqlUrl, {
						headers: {
							authorization: `Bearer ${existingToken}`
						}
					})
				);
				return;
			}
		}
	}

	const keycloak = new Keycloak({
		url: config.KEYCLOAK_URL,
		realm: config.KEYCLOAK_REALM,
		clientId: config.KEYCLOAK_CLIENT_ID
	});
	await keycloak.init({ onLoad: 'login-required', flow: 'implicit' });
	if (!keycloak.token) {
		throw new Error("Keycloak didn't return a valid token");
	}

	const { token } = keycloak;

	const exp = keycloak.tokenParsed?.exp ?? 0;
	console.debug('Token expires at', new Date(exp * 1000).toISOString());

	if (!keycloak.idTokenParsed) {
		throw new Error("Keycloak didn't return a valid idTokenParsed");
	}
	if (typeof keycloak.idTokenParsed.preferred_username !== 'string') {
		throw new TypeError("Keycloak didn't return a valid preferred_username");
	}

	// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
	const usernameFromKeycloak = keycloak.idTokenParsed.preferred_username;

	// Write to sessionStorage only after all validation has passed.
	window.sessionStorage.setItem('keycloak-token', token);
	window.sessionStorage.setItem('keycloak-exp', exp.toString());
	window.sessionStorage.setItem('keycloak-username', usernameFromKeycloak);

	const requestHeaders = {
		authorization: `Bearer ${token}`
	};
	usertoken.set(token);
	username.set(usernameFromKeycloak);

	graphQLClient.set(
		new GraphQLClient(graphqlUrl, {
			headers: requestHeaders
		})
	);
}

export default async function initKeycloak(): Promise<void> {
	if (!browser) {
		return;
	}

	const { keycloakEnabled, graphqlUrl } = parseSimPipeEnvironment();

	if (!keycloakEnabled) {
		graphQLClient.set(new GraphQLClient(graphqlUrl, {}));
		return;
	}

	// When embedded in an iframe with Keycloak enabled, receive the token from
	// the parent via postMessage instead of redirecting to Keycloak directly.
	if (window.self !== window.top) {
		if (!initKeycloakPromise) {
			initKeycloakPromise = initIframeAuth(graphqlUrl);
		}
		await initKeycloakPromise;
		return;
	}
	if (!initKeycloakPromise) {
		initKeycloakPromise = internalInitKeycloak(graphqlUrl).catch((error) => {
			console.error('[keycloak] Initialisation failed, falling back to no-auth:', error);
			console.error('[keycloak] The app is running WITHOUT authentication. Do not use in production without a working Keycloak server.');
			graphQLClient.set(new GraphQLClient(graphqlUrl, {}));
		});
	}
	await initKeycloakPromise;
}
