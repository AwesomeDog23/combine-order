import { useEffect, useState } from "react";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
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

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const { admin } = await authenticate.admin(request);
  try {
    const orderResponse = await admin.graphql(
      `#graphql
      query getOrdersWithTag($query: String!) {
        orders(first: 50, query: $query) {
          edges {
            node {
              id
              name
              tags
              totalPrice
              createdAt
              lineItems(first: 10) {
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
                firstName
                lastName
                email
              }
            }
          }
        }
      }
    `,
      { variables: { query: 'status:open AND fulfillment_status:unfulfilled AND tag:"combine this"' } }
    );

    const orderData = await orderResponse.json();

    if (orderData.errors) {
      console.error("Error fetching orders:", orderData.errors);
      throw new Error("Error fetching orders");
    }

    const ordersWithTag = orderData.data.orders.edges.map((edge) => edge.node);

    return json({ ordersWithTag });
  } catch (error) {
    console.error("Error fetching orders:", error);
    return json({ error: "Error fetching orders" });
  }
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const orderNumber = formData.get("orderNumber");
  const combineOrders = formData.get("combineOrders") === "true"; // Convert to boolean

  // Helper function to normalize address for comparison (case-insensitive)
  const normalizeAddress = (address) => {
    if (!address) return null;
    return {
      address1: address.address1?.toLowerCase().trim(),
      address2: address.address2?.toLowerCase().trim(),
      city: address.city?.toLowerCase().trim(),
      country: address.country?.toLowerCase().trim(),
      province: address.province?.toLowerCase().trim(),
      zip: address.zip?.toLowerCase().trim(),
    };
  };

  const addressesMatch = (address1, address2) => {
    if (!address1 || !address2) return false;
    return (
      address1.address1 === address2.address1 &&
      address1.address2 === address2.address2 &&
      address1.city === address2.city &&
      address1.country === address2.country &&
      address1.province === address2.province &&
      address1.zip === address2.zip
    );
  };

  try {
    // Fetch the order by order number and include variant IDs and shipping address
    const orderResponse = await admin.graphql(
      `#graphql
      query getOrder($query: String!) {
        orders(first: 1, query: $query) {
          edges {
            node {
              id
              name
              totalPrice
              lineItems(first: 10) {
                edges {
                  node {
                    id
                    name
                    quantity
                    fulfillmentStatus
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

    const orderData = await orderResponse.json(); // Parse the JSON data

    if (!orderData.data.orders.edges.length) {
      return json({ error: "Order not found" });
    }

    const foundOrder = orderData.data.orders.edges[0].node;
    const customerId = foundOrder.customer.id;
    const shippingAddress = foundOrder.shippingAddress; // Capture the shipping address

    // Normalize the shipping address of the found order for comparison
    const normalizedOriginalAddress = normalizeAddress(shippingAddress);

    // Extract the numeric part of the customer ID from the GID format
    const numericCustomerId = customerId.split("/").pop();

    // Fetch the latest open and unfulfilled orders for the customer
    const customerOrdersResponse = await admin.graphql(
      `#graphql
      query getCustomerOrders($query: String!) {
        orders(first: 10, sortKey: CREATED_AT, reverse: true, query: $query) {
          edges {
            node {
              id
              name
              totalPrice
              createdAt
              lineItems(first: 10) {
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
      { variables: { query: `status:open AND fulfillment_status:unfulfilled AND customer_id:${numericCustomerId}` } }
    );

    const customerOrdersData = await customerOrdersResponse.json(); // Parse the JSON data

    const customerOrders = customerOrdersData.data.orders.edges.map((edge) => ({
      id: edge.node.id,
      orderNumber: edge.node.name,
      totalPrice: edge.node.totalPrice,
      createdAt: edge.node.createdAt,
      lineItems: edge.node.lineItems.edges.map((itemEdge) => ({
        id: itemEdge.node.id,
        name: itemEdge.node.name,
        quantity: itemEdge.node.quantity,
        variantId: itemEdge.node.variant?.id, // Use optional chaining
      })),
      shippingAddress: normalizeAddress(edge.node.shippingAddress), // Normalize shipping address for comparison
    }));

    if (combineOrders && customerOrders.length > 0) {
      // Check if all shipping addresses are the same
      for (const order of customerOrders) {
        if (!addressesMatch(normalizedOriginalAddress, order.shippingAddress)) {
          throw new Error(
            `The shipping address for order ${order.orderNumber} does not match the original order's shipping address. All orders must have the same shipping address to be combined.`
          );
        }
      }

      // Aggregate quantities for duplicate variants, separating 'PREORDER' items
      const variantQuantityMap = {}; // For regular items
      const preorderVariantQuantityMap = {}; // For 'PREORDER' items
      const freeAndEasyRegularVariantIds = new Set(); // For "Free and Easy Returns or Exchanges" items in regular items
      const freeAndEasyPreorderVariantIds = new Set(); // For "Free and Easy Returns or Exchanges" items in preorder items

      customerOrders.forEach((order) => {
        order.lineItems.forEach((item) => {
          if (item.variantId) {
            const isPreorder = item.name.includes('PREORDER');
            const isFreeAndEasy = item.name.startsWith('Free and Easy Returns or Exchanges');

            if (isFreeAndEasy) {
              if (isPreorder) {
                freeAndEasyPreorderVariantIds.add(item.variantId);
              } else {
                freeAndEasyRegularVariantIds.add(item.variantId);
              }
            } else {
              const map = isPreorder ? preorderVariantQuantityMap : variantQuantityMap;
              if (map[item.variantId]) {
                map[item.variantId] += item.quantity;
              } else {
                map[item.variantId] = item.quantity;
              }
            }
          }
        });
      });

      const combinedLineItems = Object.keys(variantQuantityMap).map((variantId) => ({
        variantId,
        quantity: variantQuantityMap[variantId],
      }));

      const preorderLineItems = Object.keys(preorderVariantQuantityMap).map((variantId) => ({
        variantId,
        quantity: preorderVariantQuantityMap[variantId],
      }));

      // Include 'Free and Easy Returns or Exchanges' items with quantity 1
      if (combinedLineItems.length > 0) {
        freeAndEasyRegularVariantIds.forEach((variantId) => {
          combinedLineItems.push({
            variantId,
            quantity: 1,
          });
        });
      }
      if (preorderLineItems.length > 0) {
        freeAndEasyRegularVariantIds.forEach((variantId) => {
          preorderLineItems.push({
            variantId,
            quantity: 1,
          });
        });
      }

      console.log("Combined Line Items:", combinedLineItems);
      console.log("Preorder Line Items:", preorderLineItems);

      let newDraftOrder, preorderDraftOrder, completedOrder, preorderCompletedOrder;

      // Create a new draft order with combined items (regular items)
      if (combinedLineItems.length > 0) {
        const hasCombinedNonFreeAndEasyItems = combinedLineItems.some(
          (item) => !freeAndEasyRegularVariantIds.has(item.variantId)
        );

        if (hasCombinedNonFreeAndEasyItems || customerOrders.length > 1) {
          const draftOrderResponse = await admin.graphql(
            `#graphql
            mutation draftOrderCreate($input: DraftOrderInput!) {
              draftOrderCreate(input: $input) {
                draftOrder {
                  id
                  invoiceUrl
                  status
                  totalPrice
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
                  customerId: foundOrder.customer.id,
                  email: foundOrder.customer.email,
                  lineItems: combinedLineItems,
                  shippingAddress: shippingAddress, // Use the normalized shipping address
                  tags: ["combined"], // Add the 'combined' tag
                },
              },
            }
          );

          const draftOrderData = await draftOrderResponse.json(); // Parse the JSON data

          if (draftOrderData.data.draftOrderCreate.userErrors.length) {
            console.error("User Errors:", draftOrderData.data.draftOrderCreate.userErrors);
            throw new Error(
              draftOrderData.data.draftOrderCreate.userErrors
                .map((e) => e.message)
                .join(", ")
            );
          }

          newDraftOrder = draftOrderData.data.draftOrderCreate.draftOrder;

          // Complete the draft order
          const draftOrderCompleteResponse = await admin.graphql(
            `#graphql
            mutation draftOrderComplete($id: ID!) {
              draftOrderComplete(id: $id) {
                draftOrder {
                  id
                  order {
                    id
                  }
                }
              }
            }
            `,
            { variables: { id: newDraftOrder.id } }
          );

          const draftOrderCompleteData = await draftOrderCompleteResponse.json();

          if (draftOrderCompleteData.errors) {
            console.error("Error completing draft order:", draftOrderCompleteData.errors);
            throw new Error(
              draftOrderCompleteData.errors.map((e) => e.message).join(", ")
            );
          }

          completedOrder = draftOrderCompleteData.data.draftOrderComplete.draftOrder.order;
        } else {
          console.log("No regular items to create a combined order for regular items.");
          newDraftOrder = null;
        }
      }

      // Create a new draft order with 'PREORDER' items if any
      if (preorderLineItems.length > 0) {
        const hasPreorderNonFreeAndEasyItems = preorderLineItems.some(
          (item) => !freeAndEasyPreorderVariantIds.has(item.variantId)
        );

        if (hasPreorderNonFreeAndEasyItems || customerOrders.length > 1) {
          const preorderDraftOrderResponse = await admin.graphql(
            `#graphql
            mutation draftOrderCreate($input: DraftOrderInput!) {
              draftOrderCreate(input: $input) {
                draftOrder {
                  id
                  invoiceUrl
                  status
                  totalPrice
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
                  customerId: foundOrder.customer.id,
                  email: foundOrder.customer.email,
                  lineItems: preorderLineItems,
                  shippingAddress: shippingAddress, // Use the normalized shipping address
                  tags: ["combined"], // Add the 'combined' tag
                },
              },
            }
          );

          const preorderDraftOrderData = await preorderDraftOrderResponse.json();

          if (preorderDraftOrderData.data.draftOrderCreate.userErrors.length) {
            console.error("User Errors:", preorderDraftOrderData.data.draftOrderCreate.userErrors);
            throw new Error(
              preorderDraftOrderData.data.draftOrderCreate.userErrors
                .map((e) => e.message)
                .join(", ")
            );
          }

          preorderDraftOrder = preorderDraftOrderData.data.draftOrderCreate.draftOrder;

          // Complete the preorder draft order
          const preorderDraftOrderCompleteResponse = await admin.graphql(
            `#graphql
            mutation draftOrderComplete($id: ID!) {
              draftOrderComplete(id: $id) {
                draftOrder {
                  id
                  order {
                    id
                  }
                }
              }
            }
            `,
            { variables: { id: preorderDraftOrder.id } }
          );

          const preorderDraftOrderCompleteData = await preorderDraftOrderCompleteResponse.json();

          if (preorderDraftOrderCompleteData.errors) {
            console.error("Error completing preorder draft order:", preorderDraftOrderCompleteData.errors);
            throw new Error(
              preorderDraftOrderCompleteData.errors.map((e) => e.message).join(", ")
            );
          }

          preorderCompletedOrder = preorderDraftOrderCompleteData.data.draftOrderComplete.draftOrder.order;
        } else {
          console.log("No preorder items to create a combined order for preorder items.");
          preorderDraftOrder = null;
        }
      }

      if (newDraftOrder || preorderDraftOrder) {
        // After successfully creating and completing the draft orders, cancel the original customer orders
        for (const order of customerOrders) {
          const orderCancelResponse = await admin.graphql(
            `#graphql
            mutation orderCancel($orderId: ID!, $reason: OrderCancelReason!, $refund: Boolean!, $restock: Boolean!) {
              orderCancel(orderId: $orderId, reason: $reason, refund: $refund, restock: $restock) {
                job {
                  id
                }
                orderCancelUserErrors {
                  field
                  message
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
                orderId: order.id, // Pass the order ID as orderId
                reason: "OTHER", // Use the reason "combining" as specified
                refund: false, // Set refund to false
                restock: true, // Set restock to true
              },
            }
          );

          const cancelOrderData = await orderCancelResponse.json();

          if (cancelOrderData.data.orderCancel.userErrors.length) {
            console.error("Error canceling order:", cancelOrderData.data.orderCancel.userErrors);
            throw new Error(
              cancelOrderData.data.orderCancel.userErrors
                .map((e) => e.message)
                .join(", ")
            );
          }

          console.log(`Order ${order.orderNumber} canceled successfully.`);
        }

        return json({
          success: true,
          message: "New combined orders created, completed, and original orders closed successfully",
          completedOrder,
          preorderCompletedOrder,
        });
      } else {
        throw new Error("No new orders were created. Cannot proceed to cancel original orders.");
      }
    }

    const unfulfilledItems = foundOrder.lineItems.edges
      .filter((itemEdge) => itemEdge.node.fulfillmentStatus === "UNFULFILLED")
      .map((itemEdge) => ({
        id: itemEdge.node.id,
        name: itemEdge.node.name,
        quantity: itemEdge.node.quantity,
      }));

    return json({
      unfulfilledOrder: {
        orderNumber: foundOrder.name,
        totalPrice: foundOrder.totalPrice,
        unfulfilledItems,
      },
      customerOrders,
    });
  } catch (error) {
    console.error("Error fetching order or creating new order:", error);
    if (error instanceof Error) {
      return json({ error: error.message });
    } else {
      return json({ error: "There was an error processing the request." });
    }
  }
};

export default function Index() {
  const data = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const [orderNumber, setOrderNumber] = useState("");
  const [combineOrdersVisible, setCombineOrdersVisible] = useState(false);
  const isLoading =
    ["loading", "submitting"].includes(fetcher.state) &&
    fetcher.formMethod === "POST";

  const ordersWithTag = data?.ordersWithTag || [];
  const error = data?.error || fetcher.data?.error;

  const handleInputChange = (value) => {
    setOrderNumber(value);
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    // Reset combine orders visibility on new search
    setCombineOrdersVisible(false);
    fetcher.submit({ orderNumber }, { method: "POST" });
  };

  const handleCombineOrders = () => {
    // Trigger a new form submission to combine orders
    fetcher.submit(
      { orderNumber, combineOrders: "true" },
      { method: "POST" }
    );
  };

  const unfulfilledOrder = fetcher.data?.unfulfilledOrder;
  const customerOrders = fetcher.data?.customerOrders || [];

  useEffect(() => {
    if (error) {
      shopify.toast.show(error);
    } else if (fetcher.data && fetcher.data.success) {
      shopify.toast.show(fetcher.data.message);
    } else if (fetcher.data && !fetcher.data.unfulfilledOrder) {
      shopify.toast.show("No unfulfilled orders found.");
    }

    // If customer has multiple orders, show the combine button
    if (customerOrders.length > 1) {
      setCombineOrdersVisible(true);
    }
  }, [fetcher.data, error, customerOrders, shopify]);

  return (
    <Page>
      <TitleBar title="Order Lookup" />

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
                Search Orders
              </Button>
            </form>
          </Card>
        </Layout.Section>
      </Layout>

      {isLoading && <Spinner accessibilityLabel="Loading orders" size="large" />}

      {!isLoading && error && <Text color="critical">{error}</Text>}

      {!isLoading && unfulfilledOrder && (
        <BlockStack gap="500">
          <Card
            title={`Unfulfilled Items for Order #${unfulfilledOrder.orderNumber}`}
          >
            <Text>
              Order Number: {unfulfilledOrder.orderNumber} Total Price:{" "}
              {unfulfilledOrder.totalPrice}
            </Text>
            <List>
              {unfulfilledOrder.unfulfilledItems.map((item) => (
                <List.Item key={item.id}>
                  {item.name} - Quantity: {item.quantity}
                </List.Item>
              ))}
            </List>
          </Card>

          {customerOrders.length > 0 && (
            <Card title="Latest Orders for this Customer">
              <List>
                {customerOrders.map((order) => (
                  <List.Item key={order.id}>
                    <Text variant="headingLg">
                      Order #{order.orderNumber} - {order.totalPrice} - Placed
                      on: {new Date(order.createdAt).toLocaleDateString()}
                    </Text>
                    <List>
                      {order.lineItems.map((item) => (
                        <List.Item key={item.id}>
                          {item.name} - Quantity: {item.quantity}
                        </List.Item>
                      ))}
                    </List>
                  </List.Item>
                ))}
              </List>
            </Card>
          )}
        </BlockStack>
      )}

      {/* Show Combine Orders button if applicable */}
      {combineOrdersVisible && (
        <Button fullWidth primary onClick={handleCombineOrders}>
          Combine Orders
        </Button>
      )}

      {!isLoading && fetcher.data && fetcher.data.success && (
        <BlockStack gap="500">
          <Text>{fetcher.data.message}</Text>

          {fetcher.data.completedOrder && (
            <Button
              primary
              onClick={() => {
                const orderId = fetcher.data.completedOrder.id.split("/").pop();
                window.open(`shopify:admin/orders/${orderId}`, "_blank");
              }}
            >
              View New Order #{fetcher.data.completedOrder.name}
            </Button>
          )}

          {fetcher.data.preorderCompletedOrder && (
            <Button
              primary
              onClick={() => {
                const preorderOrderId = fetcher.data.preorderCompletedOrder.id
                  .split("/")
                  .pop();
                window.open(`shopify:admin/orders/${preorderOrderId}`, "_blank");
              }}
            >
              View Preorder Order #{fetcher.data.preorderCompletedOrder.name}
            </Button>
          )}
        </BlockStack>
      )}

      {!isLoading && fetcher.data && !unfulfilledOrder && !error && (
        <Text>No unfulfilled orders found.</Text>
      )}

      {ordersWithTag.length > 0 && (
        <Card title='Orders with tag "combine this"'>
          <List>
            {ordersWithTag.map((order) => (
              <List.Item key={order.id}>
                Order #{order.name} - {order.totalPrice} - Placed on:{" "}
                {new Date(order.createdAt).toLocaleDateString()}
                {/* Add button to search this order */}
                <Button
                  onClick={() =>
                    fetcher.submit(
                      { orderNumber: order.name },
                      { method: "POST" }
                    )
                  }
                >
                  View Order
                </Button>
              </List.Item>
            ))}
          </List>
        </Card>
      )}
    </Page>
  );
}