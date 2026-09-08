import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from './common/decorators/public.decorator.js';
import { OpenApiTag } from './common/swagger/openapi-tags.js';
import { AppService } from './app.service.js';

@ApiTags(OpenApiTag.Health)
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  @Public()
  @ApiOperation({ summary: 'Comprobar disponibilidad del API' })
  getHello(): string {
    return this.appService.getHello();
  }
}
