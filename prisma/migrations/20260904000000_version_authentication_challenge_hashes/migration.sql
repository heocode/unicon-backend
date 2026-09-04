-- The challenge runtime has not been introduced yet, so no production rows
-- are expected. Conversion is explicit and the length constraint makes any
-- unexpected legacy representation fail visibly instead of being accepted.
ALTER TABLE "AuthenticationChallenge"
ALTER COLUMN "otpHash" TYPE BYTEA USING convert_to("otpHash", 'UTF8'),
ALTER COLUMN "linkTokenHash" TYPE BYTEA USING convert_to("linkTokenHash", 'UTF8'),
ADD COLUMN "hashProtocolVersion" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "AuthenticationChallenge"
ALTER COLUMN "hashProtocolVersion" DROP DEFAULT,
ADD CONSTRAINT "AuthenticationChallenge_hashes_valid" CHECK (
    octet_length("otpHash") = 32
    AND octet_length("linkTokenHash") = 32
    AND "hashProtocolVersion" > 0
    AND "hashKeyVersion" > 0
);
