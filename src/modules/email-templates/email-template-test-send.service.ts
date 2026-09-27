import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { MailOutboxService } from '../../shared/mail/mail-outbox.service.js';
import { EMAIL_SAMPLE_CONTEXT, type EmailTemplateType } from './domain/email-template-catalog.js';
import type { EmailTestSendResponseDto } from './dto/email-template.responses.js';
import { EmailTemplatesService } from './email-templates.service.js';

export const EMAIL_TEMPLATE_TEST_ENTITY = 'email_template_test';

/**
 * Correo de prueba de una plantilla al usuario actual, por el outbox de correo (mismo camino que los envíos
 * reales): se encola con los datos de ejemplo del tipo y la versión elegida, se intenta enviar enseguida y se
 * responde el estado. Sin SMTP queda FAILED con el motivo (y el worker lo reintenta como cualquier otro).
 */
@Injectable()
export class EmailTemplateTestSendService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly templates: EmailTemplatesService,
    private readonly outbox: MailOutboxService,
  ) {}

  async send(
    actorId: string,
    templateType: EmailTemplateType,
    templateId: string | null,
  ): Promise<EmailTestSendResponseDto> {
    const versionId = await this.templates.resolveVersionId(templateType, templateId);
    const outboxId = await this.dataSource.transaction((manager) =>
      this.outbox.enqueue(manager, {
        templateType,
        recipientUserId: actorId,
        context: EMAIL_SAMPLE_CONTEXT[templateType],
        entityType: EMAIL_TEMPLATE_TEST_ENTITY,
        entityId: versionId,
        templateVersionId: versionId,
      }),
    );
    await this.outbox.dispatchNow(outboxId);
    const state = await this.outbox.stateOf(outboxId);
    const [recipient] = (await this.dataSource.query(
      `SELECT p.email FROM app_user u LEFT JOIN person p ON p.id = u.person_id WHERE u.id = $1`,
      [actorId],
    )) as Array<{ email: string | null }>;
    return {
      outboxId,
      status: state?.status ?? 'PENDING_SEND',
      lastError: state?.lastError ?? null,
      to: recipient?.email ?? null,
      templateId: versionId,
    };
  }
}
