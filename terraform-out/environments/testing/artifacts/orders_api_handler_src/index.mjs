export const handler = async (event) => {
  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ok: true, resource: "orders_api_handler", env: "testing", event }),
  };
};
