/**
 * Fixed part size shared by client and server. S3/R2 require every part except
 * the last to be >= 5 MiB, and all non-final parts to be the same size on R2.
 */
export const PART_SIZE = 8 * 1024 * 1024;
export const MAX_PARTS_PER_SIGN_REQUEST = 100;
