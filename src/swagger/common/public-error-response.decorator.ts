import { applyDecorators, Type } from '@nestjs/common';
import { ApiExtraModels, ApiResponse, getSchemaPath } from '@nestjs/swagger';

import { PublicErrorResponseDto } from '../../common/dtos/public-error-response.dto';
import type { PublicErrorCode } from '../../common/types/public-error-code.type';

type ApiPublicErrorResponseOptions = {
  status: number;
  codes: readonly PublicErrorCode[];
  description: string;
  detailsTypes?: readonly Type<unknown>[];
};

export function ApiPublicErrorResponse({
  status,
  codes,
  description,
  detailsTypes = [],
}: ApiPublicErrorResponseOptions) {
  const detailsSchema =
    detailsTypes.length === 1
      ? { $ref: getSchemaPath(detailsTypes[0]) }
      : detailsTypes.length > 1
        ? {
            oneOf: detailsTypes.map((type) => ({
              $ref: getSchemaPath(type),
            })),
          }
        : undefined;

  return applyDecorators(
    ApiExtraModels(PublicErrorResponseDto, ...detailsTypes),
    ApiResponse({
      status,
      description: `${description} Codes: ${codes.join(', ')}.`,
      schema: {
        allOf: [
          { $ref: getSchemaPath(PublicErrorResponseDto) },
          {
            properties: {
              code: { type: 'string', enum: [...codes] },
              ...(detailsSchema ? { details: detailsSchema } : {}),
            },
          },
        ],
      },
    }),
  );
}
