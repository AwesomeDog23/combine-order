// app/routes/split-order.jsx

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
  Checkbox,
  Spinner,
  Banner,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

// Loader Function to Authenticate and Fetch Orders with Specific Tag
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
              lineItems(first: 100) {
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

// Action Function to Handle Splitting Orders
export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const orderNumber = formData.get("orderNumber");
  const selectedItems = formData.getAll("selectedItems"); // Array of selected item IDs

  if (!orderNumber) {
    return json({ error: "Order number is required." }, { status: 400 });
  }

  if (selectedItems.length === 0) {
    return json({ error: "At least one item must be selected to split the order." }, { status: 400 });
  }

  try {
    // Fetch the original order by order number
    const orderResponse = await admin.graphql(
      `#graphql
      query getOrder($query: String!) {
        orders(first: 1, query: $query) {
          edges {
            node {
              id
              name
              totalPrice
              lineItems(first: 100) {
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
      return json({ error: "Order not found." }, { status: 404 });
    }

    const originalOrder = orderData.data.orders.edges[0].node;
    const customerId = originalOrder.customer.id;
    const customerEmail = originalOrder.customer.email;
    const shippingAddress = originalOrder.shippingAddress;

    // Prepare Line Items for New Orders
    const selectedLineItems = originalOrder.lineItems.edges
      .filter((itemEdge) => selectedItems.includes(itemEdge.node.id))
      .map((itemEdge) => ({
        variantId: itemEdge.node.variant.id,
        quantity: itemEdge.node.quantity,
      }));

    const remainingLineItems = originalOrder.lineItems.edges
      .filter((itemEdge) => !selectedItems.includes(itemEdge.node.id))
      .map((itemEdge) => ({
        variantId: itemEdge.node.variant.id,
        quantity: itemEdge.node.quantity,
      }));

    // Function to Create Draft Order
    const createDraftOrder = async (lineItems, tag) => {
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
              customerId: customerId,
              email: customerEmail,
              lineItems: lineItems,
              shippingAddress: shippingAddress,
              tags: [tag],
            },
          },
        }
      );

      const draftOrderData = await draftOrderResponse.json();

      if (draftOrderData.data.draftOrderCreate.userErrors.length) {
        throw new Error(
          draftOrderData.data.draftOrderCreate.userErrors
            .map((e) => e.message)
            .join(", ")
        );
      }

      const draftOrder = draftOrderData.data.draftOrderCreate.draftOrder;

      // Complete the Draft Order
      const draftOrderCompleteResponse = await admin.graphql(
        `#graphql
        mutation draftOrderComplete($id: ID!) {
          draftOrderComplete(id: $id) {
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
        { variables: { id: draftOrder.id } }
      );

      const draftOrderCompleteData = await draftOrderCompleteResponse.json();

      if (draftOrderCompleteData.data.draftOrderComplete.userErrors.length) {
        throw new Error(
          draftOrderCompleteData.data.draftOrderComplete.userErrors
            .map((e) => e.message)
            .join(", ")
        );
      }

      return draftOrderCompleteData.data.draftOrderComplete.draftOrder.order;
    };

    // Create New Orders
    const newOrder1 = await createDraftOrder(selectedLineItems, "split-order-1");
    const newOrder2 = await createDraftOrder(remainingLineItems, "split-order-2");

    // Cancel the Original Order
    const cancelOrderResponse = await admin.graphql(
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
          orderId: originalOrder.id,
          reason: "CUSTOMER",
          refund: false,
          restock: true,
        },
      }
    );

    const cancelOrderData = await cancelOrderResponse.json();

    if (cancelOrderData.data.orderCancel.userErrors.length) {
      throw new Error(
        cancelOrderData.data.orderCancel.userErrors
          .map((e) => e.message)
          .join(", ")
      );
    }

    return json({
      success: true,
      message: "Order split successfully.",
      newOrder1,
      newOrder2,
    });
  } catch (error) {
    console.error("Error splitting order:", error);
    return json({ error: error.message || "An error occurred while splitting the order." }, { status: 500 });
  }
};

// Default React Component for the Split Orders Page
export default function SplitOrderPage() {
  const data = useLoaderData();
  const fetcher = useFetcher();
  const appBridge = useAppBridge();
  const [orderNumber, setOrderNumber] = useState("");
  const [items, setItems] = useState([]); // List of items in the order
  const [selectedItems, setSelectedItems] = useState([]); // IDs of selected items
  const [fetchError, setFetchError] = useState("");
  const [splitError, setSplitError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [newOrders, setNewOrders] = useState([]);

  const isLoading =
    ["loading", "submitting"].includes(fetcher.state) &&
    fetcher.formMethod === "POST";

  const handleOrderNumberChange = (value) => {
    setOrderNumber(value);
  };

  const handleFetchOrder = (event) => {
    event.preventDefault();
    setFetchError("");
    setSplitError("");
    setSuccessMessage("");
    setItems([]);
    setSelectedItems([]);
    fetcher.submit({ orderNumber }, { method: "POST", action: "/split-order" });
  };

  // Effect to handle fetched data
  useEffect(() => {
    if (fetcher.type === "done" && fetcher.data) {
      if (fetcher.data.error) {
        setFetchError(fetcher.data.error);
      } else if (fetcher.data.unfulfilledOrder) {
        setItems(fetcher.data.unfulfilledOrder.unfulfilledItems);
      }
      if (fetcher.data.success) {
        setSuccessMessage(fetcher.data.message);
        setNewOrders([fetcher.data.newOrder1, fetcher.data.newOrder2]);
        setItems([]);
        setOrderNumber("");
      }
    }
  }, [fetcher]);

  // Handle Checkbox Toggle
  const handleCheckboxChange = (id) => {
    setSelectedItems((prev) =>
      prev.includes(id) ? prev.filter((itemId) => itemId !== id) : [...prev, id]
    );
  };

  // Handle Split Order Submission
  const handleSplitOrder = (event) => {
    event.preventDefault();
    if (selectedItems.length === 0) {
      setSplitError("Please select at least one item to split the order.");
      return;
    }
    fetcher.submit(
      { orderNumber, selectedItems },
      { method: "POST", action: "/split-order", replace: true }
    );
  };

  return (
    <Page>
      <TitleBar title="Split Orders" />
      <Layout>
        <Layout.Section>
          <Card sectioned>
            <form onSubmit={handleFetchOrder}>
              <TextField
                label="Order Number"
                value={orderNumber}
                onChange={handleOrderNumberChange}
                placeholder="Enter Order Number"
              />
              <Button primary submit loading={fetcher.state === "submitting"}>
                Fetch Order
              </Button>
            </form>
          </Card>
        </Layout.Section>

        {isLoading && (
          <Layout.Section>
            <Spinner accessibilityLabel="Loading" size="large" />
          </Layout.Section>
        )}

        {fetchError && (
          <Layout.Section>
            <Banner status="critical" title={fetchError} onDismiss={() => setFetchError("")} />
          </Layout.Section>
        )}

        {items.length > 0 && (
          <Layout.Section>
            <Card title={`Split Order #${orderNumber}`} sectioned>
              <form onSubmit={handleSplitOrder}>
                <List>
                  {items.map((item) => (
                    <List.Item key={item.id}>
                      <Checkbox
                        label={`${item.name} - Quantity: ${item.quantity}`}
                        checked={selectedItems.includes(item.id)}
                        onChange={() => handleCheckboxChange(item.id)}
                      />
                    </List.Item>
                  ))}
                </List>
                {splitError && (
                  <Banner status="critical" title={splitError} onDismiss={() => setSplitError("")} />
                )}
                <Button primary submit>
                  Split Order
                </Button>
              </form>
            </Card>
          </Layout.Section>
        )}

        {successMessage && (
          <Layout.Section>
            <Banner
              status="success"
              title={successMessage}
              onDismiss={() => setSuccessMessage("")}
            />
            <List>
              {newOrders.map((order) => (
                <List.Item key={order.id}>
                  <Text>
                    <strong>New Order #{order.name}</strong> -{" "}
                    <Link
                      url={`https://${appBridge.shopOrigin}/admin/orders/${order.id.split("/").pop()}`}
                      external
                    >
                      View Order
                    </Link>
                  </Text>
                </List.Item>
              ))}
            </List>
          </Layout.Section>
        )}
      </Layout>
    </Page>
  );
}