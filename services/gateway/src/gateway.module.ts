import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { PlatformModule, healthControllerFor } from '@wetriip/service-kit';
import { AuthService } from './auth.service';
import { BffController } from './bff.controller';

/**
 * The console is served by the gateway when it has been built. Missing build
 * output is not an error — the API is the product, the console is a client.
 *
 * The path is discovered by walking up rather than hard-coded, because the
 * compiled depth differs between a standalone gateway and the all-in-one host.
 */
function findWebDist(): string | null {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'web', 'dist');
    if (existsSync(join(candidate, 'index.html'))) return candidate;
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const WEB_DIST = findWebDist();

@Module({
  imports: [
    PlatformModule.forService('gateway'),
    ...(WEB_DIST
      ? [
          ServeStaticModule.forRoot({
            rootPath: WEB_DIST,
            exclude: ['/api/{*splat}', '/health/{*splat}', '/internal/{*splat}', '/webhooks/{*splat}'],
          }),
        ]
      : []),
  ],
  controllers: [BffController, healthControllerFor('gateway')],
  providers: [AuthService],
})
export class GatewayModule {}
