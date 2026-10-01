import { BadRequestException, ValidationError } from "@nestjs/common";

const LABEL: Record<string, string> = {
  name: "o nome", sku: "o SKU", barcode: "o código de barras", category: "a categoria", supplier: "o fornecedor", image: "a imagem",
  price: "o preço de venda", cost: "o preço de custo", stock: "o estoque", minStock: "o estoque mínimo", email: "o e-mail", phone: "o telefone",
  document: "o CPF/CNPJ", notes: "as observações", qty: "a quantidade", discount: "o desconto", shipping: "o frete", payment: "a forma de pagamento",
  installments: "as parcelas", city: "a cidade", state: "a UF", address: "o endereço", segment: "o segmento", password: "a senha", token: "o link",
  amount: "o valor", reason: "o motivo", counted: "o valor contado", initial: "o valor inicial", method: "a forma de pagamento", total: "o total", items: "os itens", payments: "as formas de pagamento", customerId: "o cliente", customer: "o cliente", product: "o produto", productId: "o produto", role: "a função", status: "o status", search: "a busca", page: "a página", pageSize: "o tamanho da página",
};
const label = (prop: string) => LABEL[prop] ?? "um dos campos";
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const num = (msg: string) => msg.match(/-?\d+(?:\.\d+)?/)?.[0] ?? "";

function translate(key: string, msg: string, prop: string): string {
  const l = label(prop);
  switch (key) {
    case "isNotEmpty": return LABEL[prop] ? `Informe ${l}.` : "Preencha todos os campos obrigatórios.";
    case "isString": return `${cap(l)} é inválido.`;
    case "maxLength": return `${cap(l)} é longo demais (máximo de ${num(msg)} caracteres).`;
    case "minLength": return `${cap(l)} é curto demais (mínimo de ${num(msg)} caracteres).`;
    case "isInt": return `${cap(l)} deve ser um número inteiro.`;
    case "isNumber": return /decimal/i.test(msg) ? `${cap(l)} aceita no máximo 2 casas decimais.` : `${cap(l)} deve ser um número.`;
    case "min": return `${cap(l)} deve ser no mínimo ${num(msg)}.`;
    case "max": return `${cap(l)} deve ser no máximo ${num(msg)}.`;
    case "isEmail": return "Informe um e-mail válido.";
    case "isUrl": return prop === "image" ? "A imagem enviada não é válida. Envie o arquivo novamente." : `${cap(l)} deve ser um link válido.`;
    case "isIn": case "isEnum": return `${cap(l)} é inválido.`;
    case "matches": return `${cap(l)} está em formato inválido.`;
    case "isArray": return `${cap(l)} deve ser uma lista.`;
    case "arrayMaxSize": return `${cap(l)} tem itens demais.`;
    case "whitelistValidation": return "A solicitação contém informações não permitidas.";
    default: return `${cap(l)} é inválido.`;
  }
}

const PRIORITY = ["isNotEmpty", "isString", "isNumber", "isInt", "isEmail", "isUrl", "isIn", "isEnum", "isArray", "minLength", "maxLength", "min", "max", "matches", "arrayMaxSize", "whitelistValidation"];
const rank = (k: string) => { const i = PRIORITY.indexOf(k); return i === -1 ? PRIORITY.length : i; };

function collect(errors: ValidationError[], out: string[] = []) {
  for (const e of errors) {
    if (e.constraints) {
      const [key, msg] = Object.entries(e.constraints).sort(([a], [b]) => rank(a) - rank(b))[0];
      const isDefault = msg.startsWith(`${e.property} `) || msg.startsWith(`property ${e.property} `);
      out.push(isDefault ? translate(key, msg, e.property) : msg);
    }
    if (e.children?.length) collect(e.children, out);
  }
  return out;
}

export const validationExceptionFactory = (errors: ValidationError[]) => new BadRequestException([...new Set(collect(errors))]);
