import { handle, build } from './core.js';

export default {
  fetch(request, env, ctx) {
    return handle(request, env, Date.now(), ctx);
  },
  scheduled(event, env, ctx) {
    ctx.waitUntil(build(env.DB, env, Date.now()));
  },
};
