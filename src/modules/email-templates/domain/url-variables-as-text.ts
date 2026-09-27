import type { EmailBlock, EmailDesignIssue } from './email-blocks.js';
import { extractEmailPlaceholders, urlVariables, type EmailTemplateType } from './email-template-catalog.js';
import type { RichTextParagraph } from './rich-text.js';

/**
 * Regla de diseño: una variable de enlace (kind = url en el catálogo del tipo) no se muestra como texto. Su lugar es
 * el href de un enlace del párrafo, el URL de un botón o el enlace de una imagen; como texto visible en un párrafo
 * (incluido el texto de un enlace), un título, una nota destacada o el valor de una lista de datos, el correo muestra
 * el URL crudo. Se rechaza con la ruta exacta del texto (misma forma que validateEmailBlocks / validateRichTextDoc).
 *
 * Se aplica al diseño ya validado en estructura (bloques y documento con la forma del catálogo cerrado).
 */

const message = (token: string): string => `Use la variable {{${token}}} como enlace o botón, no como texto`;

const check = (text: string, field: string, urls: ReadonlyMap<string, unknown>, issues: EmailDesignIssue[]): void => {
  for (const token of extractEmailPlaceholders(text)) {
    if (urls.has(token)) {
      issues.push({ field, message: message(token) });
    }
  }
};

const checkParagraph = (
  paragraph: RichTextParagraph,
  path: string,
  urls: ReadonlyMap<string, unknown>,
  issues: EmailDesignIssue[],
): void => {
  (paragraph.content ?? []).forEach((node, index) => {
    if (node.type === 'text') {
      check(node.text, `${path}.content[${index}].text`, urls, issues);
    }
  });
};

export const urlVariablesAsText = (
  type: EmailTemplateType,
  blocks: ReadonlyArray<EmailBlock>,
): ReadonlyArray<EmailDesignIssue> => {
  const urls = urlVariables(type);
  const issues: EmailDesignIssue[] = [];
  blocks.forEach((block, index) => {
    const path = `blocks[${index}]`;
    switch (block.type) {
      case 'heading':
      case 'callout':
        check(block.text, `${path}.text`, urls, issues);
        return;
      case 'keyValueList':
        block.items.forEach((item, itemIndex) => check(item.value, `${path}.items[${itemIndex}].value`, urls, issues));
        return;
      case 'paragraph':
        block.content.content.forEach((child, childIndex) => {
          const childPath = `${path}.content.content[${childIndex}]`;
          if (child.type === 'paragraph') {
            checkParagraph(child, childPath, urls, issues);
            return;
          }
          child.content.forEach((item, itemIndex) =>
            item.content.forEach((paragraph, paragraphIndex) =>
              checkParagraph(paragraph, `${childPath}.content[${itemIndex}].content[${paragraphIndex}]`, urls, issues),
            ),
          );
        });
        return;
      default:
        return;
    }
  });
  return issues;
};
