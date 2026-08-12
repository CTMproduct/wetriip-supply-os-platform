import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { DomainError, HTTP_STATUS_BY_CODE, newCorrelationId } from '@wetriip/contracts';
import { Logger } from '@wetriip/observability';
import { ZodError } from 'zod';

/**
 * One error shape for the whole platform.
 *
 * The console can rely on `code` to decide what to render, and every response
 * carries a correlationId the operator can paste into support. Nothing here
 * ever returns a raw stack trace or a Prisma message to a caller — those leak
 * schema details and read as noise.
 */
@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  constructor(private readonly log = new Logger('http')) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const res = http.getResponse();
    const req = http.getRequest();
    const correlationId =
      req?.wetriipContext?.correlationId ?? req?.headers?.['x-correlation-id'] ?? newCorrelationId();

    if (exception instanceof DomainError) {
      const status = HTTP_STATUS_BY_CODE[exception.code] ?? 500;
      this.log.warn('domain error', {
        correlationId,
        code: exception.code,
        path: req?.url,
        message: exception.message,
      });
      return res.status(status).json({ error: { ...exception.toJSON(), correlationId } });
    }

    if (exception instanceof ZodError) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION',
          message: 'Request failed schema validation',
          details: {
            issues: exception.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          },
          correlationId,
        },
      });
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      return res.status(status).json({
        error: {
          code: status === 404 ? 'NOT_FOUND' : status === 403 ? 'PERMISSION' : 'VALIDATION',
          message: typeof body === 'string' ? body : ((body as any)?.message ?? exception.message),
          correlationId,
        },
      });
    }

    this.log.error('unhandled error', {
      correlationId,
      path: req?.url,
      error: String(exception),
      stack: (exception as any)?.stack,
    });
    return res.status(500).json({
      error: {
        code: 'INTERNAL',
        message: 'Unexpected error. The correlation id identifies this request in the logs.',
        correlationId,
      },
    });
  }
}
