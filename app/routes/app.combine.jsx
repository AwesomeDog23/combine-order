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
  Checkbox,
  Modal,
  RadioButton,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const { admin } = await authenticate.admin(request);

  const fetchAllOrders = async (cursor = null, accumulatedOrders = []) => {
    const response = await admin.graphql(
      `#graphql
      query getOrdersWithTag($query: String!, $cursor: String) {
        orders(first: 250, query: $query, after: $cursor) {
          edges {
            cursor
            node {
              id
              name
              tags
              totalPrice
              createdAt
              lineItems(first: 250) {
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
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }`,
      {
        variables: {
          query: 'status:open AND fulfillment_status:unfulfilled AND tag:"combine this"',
          cursor: cursor,
        },
      }
    );

    const data = await response.json();
    if (data.errors) {
      console.error("Error fetching orders:", data.errors);
      throw new Error("Error fetching orders");
    }

    const newOrders = data.data.orders.edges.map((edge) => edge.node);
    const allOrders = [...accumulatedOrders, ...newOrders];

    if (data.data.orders.pageInfo.hasNextPage) {
      return fetchAllOrders(data.data.orders.pageInfo.endCursor, allOrders);
    }

    return allOrders;
  };

  try {
    const ordersWithTag = await fetchAllOrders();

    // Filter orders that do not end with "-C"
    const filteredOrders = ordersWithTag.filter((order) => !order.name.endsWith("-C"));

    return json({
      ordersWithTag: filteredOrders,
    });
  } catch (error) {
    console.error("Error fetching orders:", error);
    return json({ error: "Error fetching orders" });
  }
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const orderNumber = formData.get("orderNumber");
  const combineOrders = formData.get("combineOrders") === "true";
  const disableAddressCheck = formData.get("disableAddressCheck") === "true";
  const ignorePreorderSeparation = formData.get("ignorePreorderSeparation") === "true";

  const selectedOrders = JSON.parse(formData.get("selectedOrders") || "[]");

  const proceedDespiteAddressMismatch = formData.get("proceedDespiteAddressMismatch") === "true";
  const selectedAddressData = formData.get("selectedAddress");
  let selectedAddress = null;
  if (selectedAddressData) {
    selectedAddress = JSON.parse(selectedAddressData);
  }

  // Helper function to normalize address for comparison (case-insensitive) and include the customer's name
  const normalizeAddress = (address, customer) => {
    if (!address) return null;
    return {
      firstName: customer?.firstName || '',
      lastName: customer?.lastName || '',
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
      address1.firstName === address2.firstName &&
      address1.lastName === address2.lastName &&
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
              lineItems(first: 250) {
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
                firstName
                lastName
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
    const customerId = foundOrder.customer.id;
    const shippingAddress = foundOrder.shippingAddress;
    const customerInfo = { firstName: foundOrder.customer.firstName, lastName: foundOrder.customer.lastName };

    // Normalize the shipping address of the found order for comparison, including the customer name
    const normalizedOriginalAddress = normalizeAddress(shippingAddress, customerInfo);

    // Extract the numeric part of the customer ID from the GID format
    const numericCustomerId = customerId.split("/").pop();

    // Fetch the latest open and unfulfilled orders for the customer
    const customerOrdersResponse = await admin.graphql(
      `#graphql
      query getCustomerOrders($query: String!) {
        orders(first: 250, sortKey: CREATED_AT, reverse: true, query: $query) {
          edges {
            node {
              id
              name
              totalPrice
              createdAt
              lineItems(first: 250) {
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

    const customerOrdersData = await customerOrdersResponse.json();

    let customerOrders = customerOrdersData.data.orders.edges.map((edge) => ({
      id: edge.node.id,
      orderNumber: edge.node.name,
      totalPrice: edge.node.totalPrice,
      createdAt: edge.node.createdAt,
      lineItems: edge.node.lineItems.edges.map((itemEdge) => ({
        id: itemEdge.node.id,
        name: itemEdge.node.name,
        quantity: itemEdge.node.quantity,
        variantId: itemEdge.node.variant?.id,
      })),
      shippingAddress: normalizeAddress(edge.node.shippingAddress, customerInfo),
    }));

    // If selectedOrders is provided, filter customerOrders
    if (selectedOrders.length > 0) {
      customerOrders = customerOrders.filter(order => selectedOrders.includes(order.id));
    }

    if (combineOrders && customerOrders.length > 0) {
      if (!disableAddressCheck && !proceedDespiteAddressMismatch) {
        const mismatchedAddresses = [];
        for (const order of customerOrders) {
          if (!addressesMatch(normalizedOriginalAddress, order.shippingAddress)) {
            mismatchedAddresses.push({
              orderNumber: order.orderNumber,
              address: order.shippingAddress,
            });
          }
        }
        if (mismatchedAddresses.length > 0) {
          return json({
            addressesMismatch: true,
            mismatchedAddresses,
            originalAddress: normalizedOriginalAddress,
          });
        }
      }

      const shippingAddressToUse = selectedAddress || shippingAddress;

      if (ignorePreorderSeparation) {
        // Combine all items into a single variantQuantityMap
        const variantQuantityMap = {};
        const freeAndEasyVariantIds = new Set();
        let orderNumberSuffix = null;

        customerOrders.forEach((order) => {
          order.lineItems.forEach((item) => {
            if (item.variantId) {
              const isFreeAndEasy = item.name.startsWith('Free and Easy Returns or Exchanges');

              if (isFreeAndEasy) {
                freeAndEasyVariantIds.add(item.variantId);
                if (!orderNumberSuffix) {
                  orderNumberSuffix = order.orderNumber + "-C";
                }
              } else {
                if (variantQuantityMap[item.variantId]) {
                  variantQuantityMap[item.variantId] += item.quantity;
                } else {
                  variantQuantityMap[item.variantId] = item.quantity;
                }
                if (!orderNumberSuffix) {
                  orderNumberSuffix = order.orderNumber + "-C";
                }
              }
            }
          });
        });

        const combinedLineItems = Object.keys(variantQuantityMap).map((variantId) => ({
          variantId,
          quantity: variantQuantityMap[variantId],
        }));

        // Include 'Free and Easy Returns or Exchanges' items with quantity 1
        freeAndEasyVariantIds.forEach((variantId) => {
          combinedLineItems.push({
            variantId,
            quantity: 1,
          });
        });

        console.log("Combined Line Items:", combinedLineItems);

        let newOrder = null; // Initialize as null

        // Create new order if there are line items
        if (combinedLineItems.length > 0) {
          const lineItems = combinedLineItems.map(item => ({
            variantId: item.variantId,
            quantity: item.quantity,
            requiresShipping: true,
            priceSet: {
              shopMoney: {
                amount: "0.00",
                currencyCode: "USD",
              }
            },
          }));

          const orderCreateResponse = await admin.graphql(
            `#graphql
            mutation OrderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
              orderCreate(order: $order, options: $options) {
                order {
                  id
                  name
                  requiresShipping
                  totalTaxSet {
                    shopMoney {
                      amount
                      currencyCode
                    }
                  }
                  lineItems(first: 5) {
                    nodes {
                      variant {
                        id
                      }
                      id
                      title
                      quantity
                    }
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
                order: {
                  name: orderNumberSuffix, // Set the name to the first original order's order number
                  lineItems,
                  customerId,
                  shippingAddress: {
                    firstName: customerInfo.firstName, // Include customer's first name
                    lastName: customerInfo.lastName,   // Include customer's last name
                    address1: shippingAddress.address1,
                    address2: shippingAddress.address2,
                    city: shippingAddress.city,
                    country: shippingAddress.country,
                    province: shippingAddress.province,
                    zip: shippingAddress.zip,
                  },
                  billingAddress: {
                    firstName: customerInfo.firstName, // Include customer's first name
                    lastName: customerInfo.lastName,   // Include customer's last name
                    address1: shippingAddress.address1,
                    address2: shippingAddress.address2,
                    city: shippingAddress.city,
                    country: shippingAddress.country,
                    province: shippingAddress.province,
                    zip: shippingAddress.zip,
                  },
                  shippingLines: [
                    {
                      title: "Standard Shipping",
                      priceSet: {
                        shopMoney: {
                          amount: "0.00", // The shipping cost as a string
                          currencyCode: "USD", // The currency code
                        },
                      },
                      code: "standard",
                      source: "Custom",
                    },
                  ],
                  financialStatus: "PAID",
                  tags: [`Combined at: ${new Date().toLocaleString('en-US', { timeZone: 'America/Denver' })}`],
                },
                options: {
                  inventoryBehaviour: "DECREMENT_IGNORING_POLICY",
                  sendReceipt: true,
                },
              },
            }
          );

          const orderCreateData = await orderCreateResponse.json();

          if (orderCreateData.data.orderCreate.userErrors.length) {
            throw new Error(
              orderCreateData.data.orderCreate.userErrors
                .map((e) => e.message)
                .join(", ")
            );
          }

          newOrder = orderCreateData.data.orderCreate.order;
        } else {
          throw new Error("No items to combine");
        }

        // Cancel original orders
        for (const order of customerOrders) {
          const orderCancelResponse = await admin.graphql(
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
                orderId: order.id,
                reason: "OTHER",
                refund: false,
                restock: true,
                staffnote: 'Order combined with other orders',
              },
            }
          );

          const cancelOrderData = await orderCancelResponse.json();

          if (cancelOrderData.data.orderCancel.userErrors.length) {
            throw new Error(
              cancelOrderData.data.orderCancel.userErrors
                .map((e) => e.message)
                .join(", ")
            );
          }
        }

        return json({
          success: true,
          message: "New combined order created, and original orders canceled successfully",
          completedOrder: newOrder,
        });
      } else {
        // Combine items, separating 'PREORDER' items
        const variantQuantityMap = {}; // For regular items
        const preorderVariantQuantityMap = {}; // For 'PREORDER' items
        const freeAndEasyRegularVariantIds = new Set(); // For "Free and Easy Returns or Exchanges" items in regular items
        const freeAndEasyPreorderVariantIds = new Set(); // For "Free and Easy Returns or Exchanges" items in preorder items

        // Variables to store the first order numbers
        let regularOrderNumber = null;
        let preorderOrderNumber = null;

        customerOrders.forEach((order) => {
          order.lineItems.forEach((item) => {
            if (item.variantId) {
              const isPreorder = item.name.includes('PREORDER');
              const isFreeAndEasy = item.name.startsWith('Free and Easy Returns or Exchanges');

              if (isFreeAndEasy) {
                if (isPreorder) {
                  freeAndEasyPreorderVariantIds.add(item.variantId);
                  if (!preorderOrderNumber) {
                    preorderOrderNumber = order.orderNumber + "-C";
                  }
                } else {
                  freeAndEasyRegularVariantIds.add(item.variantId);
                  if (!regularOrderNumber) {
                    regularOrderNumber = order.orderNumber + "-C";
                  }
                }
              } else {
                const map = isPreorder ? preorderVariantQuantityMap : variantQuantityMap;
                if (map[item.variantId]) {
                  map[item.variantId] += item.quantity;
                } else {
                  map[item.variantId] = item.quantity;
                }
                if (isPreorder && !preorderOrderNumber) {
                  preorderOrderNumber = order.orderNumber + "-C";
                } else if (!isPreorder && !regularOrderNumber) {
                  regularOrderNumber = order.orderNumber + "-C";
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
          freeAndEasyPreorderVariantIds.forEach((variantId) => {
            preorderLineItems.push({
              variantId,
              quantity: 1,
            });
          });
        }

        let newRegularOrder = null; // Initialize as null
        let newPreorderOrder = null; // Initialize as null

        // Create new regular order if there are regular line items
        if (combinedLineItems.length > 0) {
          const lineItems = combinedLineItems.map(item => ({
            variantId: item.variantId,
            quantity: item.quantity,
            requiresShipping: true,
            priceSet: {
              shopMoney: {
                amount: "0.00",
                currencyCode: "USD",
              }
            },
          }));

          const regularOrderCreateResponse = await admin.graphql(
            `#graphql
            mutation OrderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
              orderCreate(order: $order, options: $options) {
                order {
                  id
                  name
                  requiresShipping
                  totalTaxSet {
                    shopMoney {
                      amount
                      currencyCode
                    }
                  }
                  lineItems(first: 5) {
                    nodes {
                      variant {
                        id
                      }
                      id
                      title
                      quantity
                    }
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
                order: {
                  name: regularOrderNumber,
                  lineItems,
                  customerId,
                  shippingAddress: {
                    firstName: customerInfo.firstName,
                    lastName: customerInfo.lastName,
                    address1: shippingAddressToUse.address1,
                    address2: shippingAddressToUse.address2,
                    city: shippingAddressToUse.city,
                    country: shippingAddressToUse.country,
                    province: shippingAddressToUse.province,
                    zip: shippingAddressToUse.zip,
                  },
                  billingAddress: {
                    firstName: customerInfo.firstName,
                    lastName: customerInfo.lastName,
                    address1: shippingAddressToUse.address1,
                    address2: shippingAddressToUse.address2,
                    city: shippingAddressToUse.city,
                    country: shippingAddressToUse.country,
                    province: shippingAddressToUse.province,
                    zip: shippingAddressToUse.zip,
                  },
                  shippingLines: [
                    {
                      title: "Standard Shipping",
                      priceSet: {
                        shopMoney: {
                          amount: "0.00",
                          currencyCode: "USD",
                        },
                      },
                      code: "standard",
                      source: "Custom",
                    },
                  ],
                  financialStatus: "PAID",
                  tags: [`Combined at: ${new Date().toLocaleString('en-US', { timeZone: 'America/Denver' })}`],
                },
                options: {
                  inventoryBehaviour: "DECREMENT_IGNORING_POLICY",
                  sendReceipt: true,
                },
              },
            }
          );

          const regularOrderCreateData = await regularOrderCreateResponse.json();

          if (regularOrderCreateData.data.orderCreate.userErrors.length) {
            throw new Error(
              regularOrderCreateData.data.orderCreate.userErrors
                .map((e) => e.message)
                .join(", ")
            );
          }

          newRegularOrder = regularOrderCreateData.data.orderCreate.order;
        }

        // Create new preorder order if there are preorder line items
        if (preorderLineItems.length > 0) {
          const lineItems = preorderLineItems.map(item => ({
            variantId: item.variantId,
            quantity: item.quantity,
            requiresShipping: true,
            priceSet: {
              shopMoney: {
                amount: "0.00",
                currencyCode: "USD",
              }
            },
          }));

          const preorderOrderCreateResponse = await admin.graphql(
            `#graphql
            mutation OrderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
              orderCreate(order: $order, options: $options) {
                order {
                  id
                  name
                  requiresShipping
                  totalTaxSet {
                    shopMoney {
                      amount
                      currencyCode
                    }
                  }
                  lineItems(first: 5) {
                    nodes {
                      variant {
                        id
                      }
                      id
                      title
                      quantity
                    }
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
                order: {
                  name: preorderOrderNumber,
                  lineItems,
                  customerId,
                  shippingAddress: {
                    firstName: customerInfo.firstName,
                    lastName: customerInfo.lastName,
                    address1: shippingAddressToUse.address1,
                    address2: shippingAddressToUse.address2,
                    city: shippingAddressToUse.city,
                    country: shippingAddressToUse.country,
                    province: shippingAddressToUse.province,
                    zip: shippingAddressToUse.zip,
                  },
                  billingAddress: {
                    firstName: customerInfo.firstName,
                    lastName: customerInfo.lastName,
                    address1: shippingAddressToUse.address1,
                    address2: shippingAddressToUse.address2,
                    city: shippingAddressToUse.city,
                    country: shippingAddressToUse.country,
                    province: shippingAddressToUse.province,
                    zip: shippingAddressToUse.zip,
                  },
                  shippingLines: [
                    {
                      title: "Standard Shipping",
                      priceSet: {
                        shopMoney: {
                          amount: "0.00",
                          currencyCode: "USD",
                        },
                      },
                      code: "standard",
                      source: "Custom",
                    },
                  ],
                  financialStatus: "PAID",
                  tags: [`Combined at: ${new Date().toLocaleString('en-US', { timeZone: 'America/Denver' })}`],
                },
                options: {
                  inventoryBehaviour: "DECREMENT_IGNORING_POLICY",
                  sendReceipt: true,
                },
              },
            }
          );

          const preorderOrderCreateData = await preorderOrderCreateResponse.json();

          if (preorderOrderCreateData.data.orderCreate.userErrors.length) {
            throw new Error(
              preorderOrderCreateData.data.orderCreate.userErrors
                .map((e) => e.message)
                .join(", ")
            );
          }

          newPreorderOrder = preorderOrderCreateData.data.orderCreate.order;
        }

        // Cancel original orders
        for (const order of customerOrders) {
          const orderCancelResponse = await admin.graphql(
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
                orderId: order.id,
                reason: "OTHER",
                refund: false,
                restock: true,
                staffnote: 'Order combined with other orders',
              },
            }
          );

          const cancelOrderData = await orderCancelResponse.json();

          if (cancelOrderData.data.orderCancel.userErrors.length) {
            throw new Error(
              cancelOrderData.data.orderCancel.userErrors
                .map((e) => e.message)
                .join(", ")
            );
          }
        }

        return json({
          success: true,
          message: "New combined orders created, and original orders canceled successfully",
          completedOrder: newRegularOrder,
          preorderCompletedOrder: newPreorderOrder,
        });
      }
    }

    return json({
      unfulfilledOrder: {
        orderNumber: foundOrder.name,
        totalPrice: foundOrder.totalPrice,
        unfulfilledItems: foundOrder.lineItems.edges
          .filter((itemEdge) => itemEdge.node.fulfillmentStatus === "UNFULFILLED")
          .map((itemEdge) => ({
            id: itemEdge.node.id,
            name: itemEdge.node.name,
            quantity: itemEdge.node.quantity,
          })),
      },
      customerOrders,
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "There was an error processing the request." });
  }
};

export default function Index() {
  const data = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const [orderNumber, setOrderNumber] = useState("");
  const [combineOrdersVisible, setCombineOrdersVisible] = useState(false);
  const [selectedOrders, setSelectedOrders] = useState([]);
  const [ordersWithTag, setOrdersWithTag] = useState(data?.ordersWithTag || []);
  const [disableAddressCheck, setDisableAddressCheck] = useState(false);
  const [ignorePreorderSeparation, setIgnorePreorderSeparation] = useState(false);
  const [isViewingOrderDetails, setIsViewingOrderDetails] = useState(false);
  const [unfulfilledOrder, setUnfulfilledOrder] = useState(null);

  const [showAddressMismatchModal, setShowAddressMismatchModal] = useState(false);
  const [mismatchedAddresses, setMismatchedAddresses] = useState([]);
  const [originalAddress, setOriginalAddress] = useState(null);
  const [selectedAddress, setSelectedAddress] = useState(null);
  const [selectedAddressId, setSelectedAddressId] = useState('original');

  const isLoading = ["loading", "submitting"].includes(fetcher.state) && fetcher.formMethod === "POST";
  const error = data?.error || fetcher.data?.error;

  const handleInputChange = (value) => {
    setOrderNumber(value);
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    setCombineOrdersVisible(false);
    setIsViewingOrderDetails(true);
    fetcher.submit(
      { orderNumber, disableAddressCheck: disableAddressCheck.toString() },
      { method: "POST" }
    );
  };

  const handleCombineOrders = () => {
    fetcher.submit(
      {
        orderNumber,
        combineOrders: "true",
        selectedOrders: JSON.stringify(selectedOrders),
        disableAddressCheck: disableAddressCheck.toString(),
        ignorePreorderSeparation: ignorePreorderSeparation.toString(),
      },
      { method: "POST" }
    );
  };

  const handleBack = () => {
    setIsViewingOrderDetails(false);
    setOrderNumber("");
    setCombineOrdersVisible(false);
    setSelectedOrders([]);
    setDisableAddressCheck(false);
    setIgnorePreorderSeparation(false);
    setUnfulfilledOrder(null);
    setShowAddressMismatchModal(false);
    fetcher.load('/'); // Reload the loader data
  };

  useEffect(() => {
    if (fetcher.data && fetcher.data.unfulfilledOrder) {
      setUnfulfilledOrder(fetcher.data.unfulfilledOrder);
    } else if (!isViewingOrderDetails) {
      setUnfulfilledOrder(null);
    }

    if (fetcher.data && fetcher.data.ordersWithTag) {
      setOrdersWithTag(fetcher.data.ordersWithTag || []);
    } else if (!isViewingOrderDetails) {
      // Reset to initial data when not viewing order details
      setOrdersWithTag(data.ordersWithTag || []);
    }

    if (fetcher.data && fetcher.data.addressesMismatch) {
      setShowAddressMismatchModal(true);
      setMismatchedAddresses(fetcher.data.mismatchedAddresses || []);
      setOriginalAddress(fetcher.data.originalAddress || null);
      setSelectedAddress(fetcher.data.originalAddress || null);
      setSelectedAddressId('original');
    }
  }, [fetcher.data, isViewingOrderDetails, data.ordersWithTag]);

  const customerOrders = fetcher.data?.customerOrders || [];

  useEffect(() => {
    if (error) {
      shopify.toast.show(error);
    } else if (fetcher.data && fetcher.data.success) {
      shopify.toast.show(fetcher.data.message);
    } else if (fetcher.data && !fetcher.data.unfulfilledOrder) {
      shopify.toast.show("No unfulfilled orders found.");
    }

    if (customerOrders.length > 1) {
      setCombineOrdersVisible(true);
      setSelectedOrders(customerOrders.map(order => order.id));
    } else {
      setCombineOrdersVisible(false);
    }
  }, [fetcher.data, error, customerOrders, shopify]);

  const handleOrderSelectionChange = (orderId, checked) => {
    if (checked) {
      setSelectedOrders([...selectedOrders, orderId]);
    } else {
      setSelectedOrders(selectedOrders.filter(id => id !== orderId));
    }
  };

  const renderAddress = (address) => {
    if (!address) return '';
    return `${address.firstName} ${address.lastName}, ${address.address1}${address.address2 ? ', ' + address.address2 : ''}, ${address.city}, ${address.province}, ${address.country}, ${address.zip}`;
  };

  const handleProceedDespiteAddressMismatch = () => {
    fetcher.submit(
      {
        orderNumber,
        combineOrders: "true",
        selectedOrders: JSON.stringify(selectedOrders),
        disableAddressCheck: disableAddressCheck.toString(),
        proceedDespiteAddressMismatch: "true",
        selectedAddress: JSON.stringify(selectedAddress),
        ignorePreorderSeparation: ignorePreorderSeparation.toString(),
      },
      { method: "POST" }
    );
    setShowAddressMismatchModal(false);
  };

  return (
    <Page>
      <TitleBar title="Combine Orders" />

      <Layout>
        <Layout.Section>
          <Card sectioned title="Search Orders">
            <form onSubmit={handleSubmit}>
              <BlockStack spacing="tight">
                <TextField
                  label="Order Number"
                  value={orderNumber}
                  onChange={handleInputChange}
                  placeholder="Enter Order Number"
                />
                <Checkbox
                  label="Disable address verification"
                  checked={disableAddressCheck}
                  onChange={(newChecked) => setDisableAddressCheck(newChecked)}
                />
                <Checkbox
                  label="Ignore preorder separation"
                  checked={ignorePreorderSeparation}
                  onChange={(newChecked) => setIgnorePreorderSeparation(newChecked)}
                />
                <Button primary submit>
                  Search Orders
                </Button>
              </BlockStack>
            </form>
          </Card>
        </Layout.Section>

        {isLoading && (
          <div className="loading-overlay">
            <Spinner accessibilityLabel="Loading orders" size="large" />
          </div>
        )}

        {error && (
          <Layout.Section>
            <Card sectioned>
              <Text color="critical">{error}</Text>
            </Card>
          </Layout.Section>
        )}

        {!isLoading && isViewingOrderDetails && unfulfilledOrder && (
          <Layout.Section>
            <Button onClick={handleBack}>Back to Order List</Button>
            <Card sectioned title={`Unfulfilled Items for Order #${unfulfilledOrder.orderNumber}`}>
              <Text>
                Total Price: {unfulfilledOrder.totalPrice}
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
                      <Checkbox
                        label={`Order #${order.orderNumber} - ${order.totalPrice} - Placed on: ${new Date(
                          order.createdAt
                        ).toLocaleDateString()}`}
                        checked={selectedOrders.includes(order.id)}
                        onChange={(checked) => handleOrderSelectionChange(order.id, checked)}
                      />
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
          </Layout.Section>
        )}

        {combineOrdersVisible && (
          <Layout.Section>
            <Button fullWidth primary onClick={handleCombineOrders}>
              Combine Orders
            </Button>
          </Layout.Section>
        )}

        {!isLoading && fetcher.data && fetcher.data.success && (
          <Layout.Section>
            <Card sectioned>
              <Text>{fetcher.data.message}</Text>
              {fetcher.data.completedOrder && (
                <Button
                  primary
                  onClick={() => {
                    const orderId = fetcher.data.completedOrder.id.split("/").pop();
                    window.open(`shopify:/admin/orders/${orderId}`, "_blank");
                  }}
                >
                  View New Order #{fetcher.data.completedOrder.name}
                </Button>
              )}
              {fetcher.data.preorderCompletedOrder && (
                <Button
                  primary
                  onClick={() => {
                    const preorderOrderId = fetcher.data.preorderCompletedOrder.id.split("/").pop();
                    window.open(`shopify:/admin/orders/${preorderOrderId}`, "_blank");
                  }}
                >
                  View New Preorder Order #{fetcher.data.preorderCompletedOrder.name}
                </Button>
              )}
            </Card>
          </Layout.Section>
        )}

        {!isViewingOrderDetails && ordersWithTag.length > 0 && (
          <Layout.Section>
            <Card title='Orders with tag "combine this"'>
              <List>
                {ordersWithTag.map((order) => (
                  <List.Item key={order.id}>
                    Order #{order.name} - {order.totalPrice} - Placed on:{" "}
                    {new Date(order.createdAt).toLocaleDateString()}
                    <Button
                      onClick={() => {
                        setIsViewingOrderDetails(true);
                        setOrderNumber(order.name);
                        fetcher.submit({ orderNumber: order.name }, { method: "POST" });
                      }}
                    >
                      View Order
                    </Button>
                  </List.Item>
                ))}
              </List>
            </Card>
          </Layout.Section>
        )}
      </Layout>

      <Modal
        open={showAddressMismatchModal}
        onClose={() => setShowAddressMismatchModal(false)}
        title="Addresses do not match"
        primaryAction={{
          content: 'Proceed',
          onAction: handleProceedDespiteAddressMismatch,
        }}
        secondaryActions={[
          {
            content: 'Cancel',
            onAction: () => setShowAddressMismatchModal(false),
          },
        ]}
      >
        <Modal.Section>
          <Text>The shipping addresses of the orders do not match. Please select an address to use for the combined order, or cancel the operation.</Text>
          <BlockStack spacing="tight">
            <RadioButton
              label={`Original Address: ${renderAddress(originalAddress)}`}
              checked={selectedAddressId === 'original'}
              id="originalAddress"
              name="addresses"
              onChange={() => {
                setSelectedAddressId('original');
                setSelectedAddress(originalAddress);
              }}
            />
            {mismatchedAddresses.map((item, index) => (
              <RadioButton
                key={index}
                label={`Order #${item.orderNumber} Address: ${renderAddress(item.address)}`}
                checked={selectedAddressId === `order${item.orderNumber}`}
                id={`address${index}`}
                name="addresses"
                onChange={() => {
                  setSelectedAddressId(`order${item.orderNumber}`);
                  setSelectedAddress(item.address);
                }}
              />
            ))}
          </BlockStack>
        </Modal.Section>
      </Modal>

      <style>
        {`
          .loading-overlay {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            background-color: rgba(255, 255, 255, 0.7);
            z-index: 9999;
          }
        `}
      </style>
    </Page>
  );
}