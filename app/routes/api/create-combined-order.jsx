import { json } from "@remix-run/node"; // or "@remix-run/server-runtime"
import { authenticate } from "../../shopify.server"; // Assuming this exists in your project

export const action = async ({ request }) => {
  console.log("Request received for creating combined order");
  
  const { admin } = await authenticate.admin(request);
  const { customerId, lineItems } = await request.json(); // Parse the JSON body
  
  try {
    // Mutation to create a draft order in Shopify
    const createOrderResponse = await admin.graphql(
      `#graphql
        mutation {
          draftOrderCreate(input: {
            customerId: "${customerId}",
            lineItems: ${JSON.stringify(lineItems)}
          }) {
            draftOrder {
              id
              name
            }
          }
        }
      `
    );

    const result = await createOrderResponse.json();
    return json({ success: true, draftOrderId: result.data.draftOrderCreate.draftOrder.id });
  } catch (error) {
    console.error("Error creating order:", error);
    return json({ success: false, error: error.message }, { status: 500 });
  }
};