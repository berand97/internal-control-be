import type { EmailBlock, EmailDesignIssue } from './email-blocks.js';
import { extractEmailPlaceholders, urlVariables, type EmailTemplateType } from './email-template-catalog.js';
import type { RichTextParagraph } from './rich-text.js';

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
