/** Health for ars-signer: the site's healer polls this shape. */
module.exports = (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.status(200).json({ ok: true, service: "ars-signer", at: new Date().toISOString() });
};
