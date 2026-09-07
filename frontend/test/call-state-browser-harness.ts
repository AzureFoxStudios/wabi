import { WabiDbCallState } from '../src/lib/wabidbCallConnection';
import { getAuthToken, setAuthToken, clearAuthToken, setPersistentAuthToken } from '../src/lib/authSession';
import { getRefreshToken, setRefreshToken, clearRefreshToken, tryRefresh } from '../src/lib/api/authRefresh';

let client: WabiDbCallState | null = null;
const events: string[] = [];
(window as any).__callState = {
  getAuthToken, setAuthToken, clearAuthToken, setPersistentAuthToken, getRefreshToken, setRefreshToken, clearRefreshToken, tryRefresh, events,
  async connect(base: string) {
    client = new WabiDbCallState({ serverUrl: base }, {
      getToken: () => getAuthToken(base), refresh: () => tryRefresh(base)
    });
    client.onConnect(() => events.push('connected'));
    client.onDisconnect(() => events.push('disconnected'));
    client.onError(error => events.push(error.message));
    await Promise.all([client.requestConnect(), client.requestConnect()]);
    return client.isConnected;
  },
  ready: () => client?.isConnected ?? false,
  disconnect: () => client?.disconnect()
};
