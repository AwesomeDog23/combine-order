import { useEffect, useState } from "react";
import { json } from "@remix-run/node";
import { useFetcher } from "@remix-run/react";
import {
  Page,
  Layout,
  Text,
  Card,
  Button,
  BlockStack,
  List,
  TextField,
  Spinner,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const orderNumber = formData.get("orderNumber");
  const splitOrder = formData.get("splitOrder") === "true";

  try {
    // Fetch the order by order number
    const orderResponse = await admin.graphql(
      `#graphql
      query getOrder($query: String!) {
        orders(first: 1, query: $query) {
          edges {
            node {
              id
              name
              lineItems(first: 50) {
                edges {
                  node {
                    id
                    name
                    quantity
                    variant {
                      id
                    }
                  }
                }
              }
              customer {
                id
                email
              }
              shippingAddress {
                address1
                address2
                city
                country
                zip
                province
              }
            }
          }
        }
      }
    `,
      { variables: { query: `name:${orderNumber}` } }
    );

    const orderData = await orderResponse.json();

    if (!orderData.data.orders.edges.length) {
      return json({ error: "Order not found" });
    }

    const foundOrder = orderData.data.orders.edges[0].node;

    if (!splitOrder) {
      // Return the order data
      return json({ order: foundOrder });
    } else {
      const splitQuantities = JSON.parse(formData.get("splitQuantities"));

      const selectedItems = [];
      const unselectedItems = [];

      // Split the items based on the provided split quantities
      foundOrder.lineItems.edges.forEach((itemEdge) => {
        const item = itemEdge.node;
        const splitQuantity = splitQuantities[item.variant.id] || 0;

        if (splitQuantity > 0) {
          // Push items with the split quantity to the first order
          selectedItems.push({
            ...item,
            quantity: splitQuantity,
          });
        }

        const remainingQuantity = item.quantity - splitQuantity;
        if (remainingQuantity > 0) {
          // Push remaining items to the second order
          unselectedItems.push({
            ...item,
            quantity: remainingQuantity,
          });
        }
      });

      // If there are no unselected items, handle the error here
      if (unselectedItems.length === 0) {
        return json({
          error: "There are no items left to create the second order.",
        });
      }

      // Prepare line items for the new orders
      const selectedLineItems = selectedItems.map((item) => ({
        variantId: item.variant.id,
        quantity: item.quantity,
      }));

      const unselectedLineItems = unselectedItems.map((item) => ({
        variantId: item.variant.id,
        quantity: item.quantity,
      }));

      const customerId = foundOrder.customer?.id;
      const email = foundOrder.customer?.email;
      const shippingAddress = foundOrder.shippingAddress;

      // Create the first draft order with selected items
      let newOrder1 = null;
      if (selectedLineItems.length > 0) {
        const draftOrderResponse1 = await admin.graphql(
          `#graphql
          mutation draftOrderCreate($input: DraftOrderInput!) {
            draftOrderCreate(input: $input) {
              draftOrder {
                id
                order {
                  id
                  name
                }
              }
              userErrors {
                field
                message
              }
            }
          }
        `,
          {
            variables: {
              input: {
                lineItems: selectedLineItems,
                customerId,
                email,
                shippingAddress,
              },
            },
          }
        );

        const draftOrderData1 = await draftOrderResponse1.json();
        if (draftOrderData1.data.draftOrderCreate.userErrors.length) {
          return json({
            error: draftOrderData1.data.draftOrderCreate.userErrors
              .map((e) => e.message)
              .join(", "),
          });
        }

        // Complete the draft order
        const draftOrderId1 = draftOrderData1.data.draftOrderCreate.draftOrder.id;
        const completeResponse1 = await admin.graphql(
          `#graphql
          mutation draftOrderComplete($id: ID!) {
            draftOrderComplete(id: $id) {
              draftOrder {
                order {
                  id
                  name
                }
              }
              userErrors {
                field
                message
              }
            }
          }
        `,
          { variables: { id: draftOrderId1 } }
        );

        const completeData1 = await completeResponse1.json();
        if (completeData1.data.draftOrderComplete.userErrors.length) {
          return json({
            error: completeData1.data.draftOrderComplete.userErrors
              .map((e) => e.message)
              .join(", "),
          });
        }

        newOrder1 = completeData1.data.draftOrderComplete.draftOrder.order;
      }

      // Ensure unselected items always result in a second order
      let newOrder2 = null;
      if (unselectedLineItems.length > 0) {
        const draftOrderResponse2 = await admin.graphql(
          `#graphql
          mutation draftOrderCreate($input: DraftOrderInput!) {
            draftOrderCreate(input: $input) {
              draftOrder {
                id
                order {
                  id
                  name
                }
              }
              userErrors {
                field
                message
              }
            }
          }
        `,
          {
            variables: {
              input: {
                lineItems: unselectedLineItems,
                customerId,
                email,
                shippingAddress,
              },
            },
          }
        );

        const draftOrderData2 = await draftOrderResponse2.json();
        if (draftOrderData2.data.draftOrderCreate.userErrors.length) {
          return json({
            error: draftOrderData2.data.draftOrderCreate.userErrors
              .map((e) => e.message)
              .join(", "),
          });
        }

        // Complete the second draft order
        const draftOrderId2 = draftOrderData2.data.draftOrderCreate.draftOrder.id;
        const completeResponse2 = await admin.graphql(
          `#graphql
          mutation draftOrderComplete($id: ID!) {
            draftOrderComplete(id: $id) {
              draftOrder {
                order {
                  id
                  name
                }
              }
              userErrors {
                field
                message
              }
            }
          }
        `,
          { variables: { id: draftOrderId2 } }
        );

        const completeData2 = await completeResponse2.json();
        if (completeData2.data.draftOrderComplete.userErrors.length) {
          return json({
            error: completeData2.data.draftOrderComplete.userErrors
              .map((e) => e.message)
              .join(", "),
          });
        }

        newOrder2 = completeData2.data.draftOrderComplete.draftOrder.order;
      }

      // Cancel the original order only if both orders are created
      const cancelOrderResponse = await admin.graphql(
        `#graphql
        mutation orderCancel($orderId: ID!, $reason: OrderCancelReason!, $refund: Boolean!, $restock: Boolean!) {
          orderCancel(orderId: $orderId, reason: $reason, refund: $refund, restock: $restock) {
            job {
              id
            }
            userErrors {
              field
              message
            }
          }
        }
        `,
        {
          variables: {
            orderId: foundOrder.id,
            reason: "OTHER",
            refund: false,
            restock: true,
          },
        }
      );

      const cancelOrderData = await cancelOrderResponse.json();
      if (cancelOrderData.data.orderCancel.userErrors.length) {
        return json({
          error: cancelOrderData.data.orderCancel.userErrors
            .map((e) => e.message)
            .join(", "),
        });
      }

      return json({
        success: true,
        message: "Order split successfully",
        newOrder1,
        newOrder2,
      });
    }
  } catch (error) {
    return json({ error: error.message });
  }
};

export default function SplitOrderPage() {
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const [orderNumber, setOrderNumber] = useState("");
  const [splitQuantities, setSplitQuantities] = useState({});

  const isLoading =
    ["loading", "submitting"].includes(fetcher.state) &&
    fetcher.formMethod === "POST";

  const error = fetcher.data?.error;

  const order = fetcher.data?.order;

  const handleInputChange = (value) => {
    setOrderNumber(value);
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    fetcher.submit({ orderNumber }, { method: "POST" });
  };

  const handleQuantityChange = (variantId) => (value) => {
    setSplitQuantities((prev) => ({
      ...prev,
      [variantId]: parseInt(value, 10) || 0,
    }));
  };

  const handleSplitOrder = () => {
    // Prepare the split quantities to send to the server
    fetcher.submit(
      {
        orderNumber,
        splitOrder: "true",
        splitQuantities: JSON.stringify(splitQuantities),
      },
      { method: "POST" }
    );
  };

  useEffect(() => {
    if (error) {
      shopify.toast.show(error);
    } else if (fetcher.data && fetcher.data.success) {
      shopify.toast.show(fetcher.data.message);
    }
  }, [fetcher.data, error, shopify]);

  return (
    <Page>
      <TitleBar title="Split Order" />

      <Layout>
        <Layout.Section>
          <Card sectioned>
            <form onSubmit={handleSubmit}>
              <TextField
                label="Order Number"
                value={orderNumber}
                onChange={handleInputChange}
                placeholder="Enter Order Number"
              />
              <Button primary submit>
                Search Order
              </Button>
            </form>
          </Card>
        </Layout.Section>
      </Layout>

      {isLoading && <Spinner accessibilityLabel="Loading order" size="large" />}

      {!isLoading && error && <Text color="critical">{error}</Text>}

      {!isLoading && order && (
        <BlockStack gap="500">
          <Card title={`Order #${order.name}`}>
            <List>
              {order.lineItems.edges.map((itemEdge) => {
                const item = itemEdge.node;
                return (
                  <List.Item key={item.id}>
                    <Text>{`${item.name} - Quantity: ${item.quantity}`}</Text>
                    <TextField
                      label="Quantity for First Order"
                      value={splitQuantities[item.variant.id] || ""}
                      onChange={handleQuantityChange(item.variant.id)}
                      placeholder="Enter quantity"
                      type="number"
                      min={0}
                      max={item.quantity}
                    />
                  </List.Item>
                );
              })}
            </List>
          </Card>
          <Button primary onClick={handleSplitOrder}>
            Split Order
          </Button>
        </BlockStack>
      )}

      {!isLoading && fetcher.data && fetcher.data.success && (
        <BlockStack gap="500">
          <Text>{fetcher.data.message}</Text>
          {fetcher.data.newOrder1 && (
            <Button
              primary
              onClick={() => {
                const orderId = fetcher.data.newOrder1.id.split("/").pop();
                window.open(`shopify:admin/orders/${orderId}`, "_blank");
              }}
            >
              View New Order #{fetcher.data.newOrder1.name}
            </Button>
          )}
          {fetcher.data.newOrder2 && (
            <Button
              primary
              onClick={() => {
                const orderId = fetcher.data.newOrder2.id.split("/").pop();
                window.open(`shopify:admin/orders/${orderId}`, "_blank");
              }}
            >
              View New Order #{fetcher.data.newOrder2.name}
            </Button>
          )}
        </BlockStack>
      )}
    </Page>
  );
}