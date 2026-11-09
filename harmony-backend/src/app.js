import { createAppCore } from './app-core.js';
import { createAccountRoutes } from './account-routes.js';

export function createApp(options = {}) {
  return createAppCore(options, createAccountRoutes);
}
