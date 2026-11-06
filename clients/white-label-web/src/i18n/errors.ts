/**
 * RFC 9457 problems → friendly, localised sentences, keyed by the API's stable `code`
 * (src/common/errors/error-codes.ts). The raw code is still shown, small, for the demo.
 */
import { ApiError } from '../api/api';

import { languageOf, type Language } from './messages';

type Messages = Record<string, string>;

const EN: Messages = {
  VALIDATION_FAILED: 'Some details need fixing.',
  AMOUNT_OUT_OF_PRODUCT_RANGE: 'This amount is outside what this product can finance.',
  TERM_OUT_OF_PRODUCT_RANGE: 'This repayment period is not offered for this product.',
  CURRENCY_MISMATCH: 'Your account and this product use different currencies.',
  UNSUPPORTED_CURRENCY: 'This lender does not lend in that currency.',
  PRODUCT_NOT_ACTIVE: 'This product is no longer offered.',
  KYC_NOT_VERIFIED: 'We could not verify your BVN/NIN yet, so we cannot accept an application.',
  ASSESSMENT_REQUIRED: 'Run the credit assessment before deciding.',
  ASSESSMENT_DECLINED: 'The credit assessment declined this application.',
  APPROVED_AMOUNT_EXCEEDS_REQUEST: 'You cannot approve more than was requested.',
  APPROVED_AMOUNT_EXCEEDS_AFFORDABLE: 'That is more than the applicant can afford.',
  APPLICATION_EXPIRED: 'This approval has expired.',
  APR_EXCEEDS_CAP: 'The all-in APR would exceed this lender’s legal APR cap.',
  PAYEE_NOT_ALLOWED: 'Checkout financing can only pay the supplier of this order.',
  VALUE_DATE_OUT_OF_RANGE:
    'The value date must be today or within the last 3 days, and not before the last repayment.',
  EXTERNAL_REFERENCE_REQUIRED: 'Enter the statement or transfer reference for this payment.',
  REGISTRATION_CONFLICT: 'An account already exists with these details. Sign in instead.',
  CHECKOUT_ORDER_NOT_FOUND: 'The supplier’s checkout does not know this order.',
  ORDER_AMOUNT_EXCEEDED: 'The amount is more than the order total.',
  ORDER_NOT_FOR_APPLICANT: 'This order belongs to another buyer.',
  ORDER_REFERENCE_NOT_ALLOWED: 'Order references apply only to checkout (supplier-paid) products.',
  ORDER_ALREADY_FINANCED: 'This order has already been financed.',
  REPAYMENT_EXCEEDS_PAYOFF: 'That is more than the amount needed to close this loan.',
  IDEMPOTENCY_KEY_REQUIRED: 'The request was missing its idempotency key.',
  IDEMPOTENCY_KEY_REUSED: 'This action was already sent with different details. Start it again.',
  WRONG_CELL: 'This lender is served from another region.',
  CELL_ROUTING_REFUSED:
    'This lender’s server pointed us to an address this app does not trust, so nothing was sent there.',
  UNAUTHENTICATED: 'Please sign in again.',
  INVALID_CREDENTIALS: 'Email or password is not right.',
  ACCOUNT_LOCKED: 'Too many attempts. The account is locked for 15 minutes.',
  INVALID_REFRESH_TOKEN: 'Your session ended. Please sign in again.',
  FORBIDDEN: 'Your role cannot do this.',
  SOD_VIOLATION: 'Maker-checker: the same person cannot do both steps. Ask a colleague.',
  INSTITUTION_SUSPENDED: 'This lender is temporarily unavailable.',
  MISDIRECTED_REQUEST: 'Your session belongs to another region. Please sign in again.',
  NOT_FOUND: 'We could not find that.',
  CONFLICT: 'That conflicts with the current state. Refresh and try again.',
  INVALID_STATE_TRANSITION: 'That step is not possible in the current status.',
  CONCURRENT_MODIFICATION: 'Someone else changed this just now. Refresh and try again.',
  DUPLICATE: 'That already exists.',
  RATE_LIMITED: 'Too many requests. Please wait a moment.',
  DISBURSEMENT_PROVIDER_FAILED: 'The payment provider did not accept the payout. Try again.',
  UPSTREAM_UNAVAILABLE: 'A partner service is unavailable. Try again shortly.',
  INTERNAL_ERROR: 'Something went wrong on our side.',
  NETWORK_ERROR: 'Cannot reach the lender’s server. Check your connection.',
};

const FR: Messages = {
  VALIDATION_FAILED: 'Certaines informations sont à corriger.',
  AMOUNT_OUT_OF_PRODUCT_RANGE: 'Ce montant est hors des limites de ce produit.',
  TERM_OUT_OF_PRODUCT_RANGE: 'Cette durée n’est pas proposée pour ce produit.',
  CURRENCY_MISMATCH: 'Votre compte et ce produit utilisent des devises différentes.',
  UNSUPPORTED_CURRENCY: 'Ce prêteur ne prête pas dans cette devise.',
  PRODUCT_NOT_ACTIVE: 'Ce produit n’est plus proposé.',
  KYC_NOT_VERIFIED: 'Votre identité n’est pas encore vérifiée.',
  ASSESSMENT_REQUIRED: 'Lancez l’analyse de crédit avant de décider.',
  ASSESSMENT_DECLINED: 'L’analyse de crédit a refusé cette demande.',
  APPROVED_AMOUNT_EXCEEDS_REQUEST: 'Impossible d’approuver plus que le montant demandé.',
  APPROVED_AMOUNT_EXCEEDS_AFFORDABLE: 'Ce montant dépasse la capacité de remboursement.',
  APPLICATION_EXPIRED: 'Cette approbation a expiré.',
  APR_EXCEEDS_CAP: 'Le TAEG dépasserait le plafond légal de ce prêteur.',
  PAYEE_NOT_ALLOWED: 'Le financement ne peut payer que le fournisseur de cette commande.',
  VALUE_DATE_OUT_OF_RANGE:
    'La date de valeur doit être aujourd’hui ou dans les 3 derniers jours, et pas avant le dernier remboursement.',
  EXTERNAL_REFERENCE_REQUIRED: 'Saisissez la référence du relevé ou du virement.',
  REGISTRATION_CONFLICT: 'Un compte existe déjà avec ces informations. Connectez-vous.',
  CHECKOUT_ORDER_NOT_FOUND: 'Le site du fournisseur ne connaît pas cette commande.',
  ORDER_AMOUNT_EXCEEDED: 'Le montant dépasse le total de la commande.',
  ORDER_NOT_FOR_APPLICANT: 'Cette commande appartient à un autre acheteur.',
  ORDER_REFERENCE_NOT_ALLOWED:
    'Les références de commande ne s’appliquent qu’aux produits de financement d’achat (payés au fournisseur).',
  ORDER_ALREADY_FINANCED: 'Cette commande a déjà été financée.',
  REPAYMENT_EXCEEDS_PAYOFF: 'Ce montant dépasse le solde nécessaire pour clôturer le prêt.',
  IDEMPOTENCY_KEY_REQUIRED: 'La clé d’idempotence manquait.',
  IDEMPOTENCY_KEY_REUSED: 'Cette action a déjà été envoyée avec d’autres données.',
  CELL_ROUTING_REFUSED:
    'Le serveur du prêteur a indiqué une adresse non reconnue par cette application : rien n’y a été envoyé.',
  WRONG_CELL: 'Ce prêteur est servi depuis une autre région.',
  UNAUTHENTICATED: 'Veuillez vous reconnecter.',
  INVALID_CREDENTIALS: 'E-mail ou mot de passe incorrect.',
  ACCOUNT_LOCKED: 'Trop de tentatives. Compte bloqué 15 minutes.',
  INVALID_REFRESH_TOKEN: 'Votre session a expiré. Veuillez vous reconnecter.',
  FORBIDDEN: 'Votre rôle ne permet pas cette action.',
  SOD_VIOLATION: 'Double contrôle : la même personne ne peut pas faire les deux étapes.',
  INSTITUTION_SUSPENDED: 'Ce prêteur est temporairement indisponible.',
  MISDIRECTED_REQUEST: 'Votre session appartient à une autre région. Reconnectez-vous.',
  NOT_FOUND: 'Introuvable.',
  CONFLICT: 'Conflit avec l’état actuel. Actualisez et réessayez.',
  INVALID_STATE_TRANSITION: 'Cette étape n’est pas possible dans le statut actuel.',
  CONCURRENT_MODIFICATION: 'Quelqu’un vient de modifier cet élément. Actualisez.',
  DUPLICATE: 'Cela existe déjà.',
  RATE_LIMITED: 'Trop de requêtes. Patientez un instant.',
  DISBURSEMENT_PROVIDER_FAILED: 'Le prestataire de paiement a refusé le versement.',
  UPSTREAM_UNAVAILABLE: 'Un service partenaire est indisponible.',
  INTERNAL_ERROR: 'Une erreur est survenue de notre côté.',
  NETWORK_ERROR: 'Impossible de joindre le serveur du prêteur.',
};

const BY_STATUS_EN: Record<number, string> = {
  400: 'The request was not accepted.',
  401: EN.UNAUTHENTICATED ?? '',
  403: EN.FORBIDDEN ?? '',
  404: EN.NOT_FOUND ?? '',
  409: EN.CONFLICT ?? '',
  422: 'The request breaks a business rule.',
  429: EN.RATE_LIMITED ?? '',
};

export interface FriendlyError {
  message: string;
  code: string;
  status: number;
  traceId: string | null;
  fields: { field: string; message: string }[];
}

export function describeError(err: unknown, locale: string): FriendlyError {
  const lang: Language = languageOf(locale);
  const dict = lang === 'fr' ? FR : EN;
  if (err instanceof ApiError) {
    const { problem } = err;
    const code = err.code;
    const message =
      dict[code] ??
      EN[code] ??
      BY_STATUS_EN[problem.status] ??
      (lang === 'fr' ? 'Une erreur est survenue.' : 'Something went wrong.');
    return {
      message,
      code,
      status: problem.status,
      traceId: problem.traceId ?? null,
      fields: Array.isArray(problem.errors) ? problem.errors : [],
    };
  }
  return {
    message: err instanceof Error ? err.message : String(err),
    code: 'CLIENT_ERROR',
    status: 0,
    traceId: null,
    fields: [],
  };
}

/** Plain-language reason codes of the scorecard (SPEC §7.6). */
export const REASON_TEXT: Record<string, { en: string; fr: string }> = {
  R01_DTI_ABOVE_THRESHOLD: { en: 'Repayments too high for income', fr: 'Mensualités trop élevées' },
  R02_LOW_BUREAU_SCORE: { en: 'Low credit bureau score', fr: 'Score bureau faible' },
  R03_SHORT_EMPLOYMENT_TENURE: { en: 'Short trading history', fr: 'Historique d’activité court' },
  R04_BUREAU_DELINQUENCY: { en: 'Delinquency on bureau file', fr: 'Incident au bureau de crédit' },
  R05_KYC_NOT_VERIFIED: { en: 'Identity not verified', fr: 'Identité non vérifiée' },
  R06_AGE_OUT_OF_RANGE: { en: 'Age outside policy', fr: 'Âge hors politique' },
  R07_EXISTING_DELINQUENCY: { en: 'Existing loan in arrears', fr: 'Prêt existant en retard' },
  R08_BELOW_MIN_SCORE: { en: 'Score below product minimum', fr: 'Score sous le minimum' },
};

export const REASON_CODES = Object.keys(REASON_TEXT);

export function reasonText(code: string, locale: string): string {
  const entry = REASON_TEXT[code];
  if (!entry) return code;
  return languageOf(locale) === 'fr' ? entry.fr : entry.en;
}
