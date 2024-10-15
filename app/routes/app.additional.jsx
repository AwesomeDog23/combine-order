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
  Checkbox,
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
      // Proceed to split the order
      // Get the selected items from formData
      const selectedItemIds = formData.getAll("selectedItems[]");

      // Separate the line items into two groups
      const selectedItems = [];
      const unselectedItems = [];

      foundOrder.lineItems.edges.forEach((itemEdge) => {
        const item = itemEdge.node;
        if (selectedItemIds.includes(item.id)) {
          selectedItems.push(item);
        } else {
          unselectedItems.push(item);
        }
      });

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

      // Create the second draft order with unselected items
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

        // Complete the draft order
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

      // Cancel the original order
      const cancelOrderResponse = await admin.graphql(
        `#graphql
        mutation orderCancel($id: ID!, $reason: OrderCancelReason!) {
          orderCancel(id: $id, reason: $reason) {
            order {
              id
              name
            }
            userErrors {
              field
              message
            }
          }
        }
      `,
        { variables: { id: foundOrder.id, reason: "OTHER" } }
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
  const [selectedItems, setSelectedItems] = useState({});

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

  const handleCheckboxChange = (itemId) => (checked) => {
    setSelectedItems({
      ...selectedItems,
      [itemId]: checked,
    });
  };

  const handleSplitOrder = () => {
    // Prepare selected item IDs
    const selectedItemIds = Object.keys(selectedItems).filter(
      (itemId) => selectedItems[itemId]
    );
    fetcher.submit(
      { orderNumber, splitOrder: "true", "selectedItems[]": selectedItemIds },
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

      {isLoading && (
        <Spinner accessibilityLabel="Loading order" size="large" />
      )}

      {!isLoading && error && <Text color="critical">{error}</Text>}

      {!isLoading && order && (
        <BlockStack gap="500">
          <Card title={`Order #${order.name}`}>
            <List>
              {order.lineItems.edges.map((itemEdge) => {
                const item = itemEdge.node;
                return (
                  <List.Item key={item.id}>
                    <Checkbox
                      label={`${item.name} - Quantity: ${item.quantity}`}
                      checked={selectedItems[item.id] || false}
                      onChange={handleCheckboxChange(item.id)}
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